import fs from 'node:fs';
import { eventLogFile } from './config';
import {
	countLines,
	eventsAfter,
	isGap,
	maxSeq,
	parseEventLines,
	serializeEventLine,
	shouldRotate,
	type SeqEvent
} from './event-log-core';

// Durable, monotonically-sequenced agent event log (issue #143). Every agent
// event is assigned a global `seq` and appended to ~/.deck/events.jsonl as one
// JSON line, so a consumer (Hermes) can tail the file or read the HTTP cursor,
// stop, restart, and resume from its last seq with no lost events. The pure bits
// (serialize/parse, cursor filter, gap test, rotation threshold) live in
// event-log-core.ts; this module owns the counter, the ordered async writer, and
// rotation. Writing under ~/.deck is deck's own data dir (like transcripts), not
// a confined project path.

const ROTATED = `${eventLogFile}.1`;

interface LogState {
	// Highest seq assigned so far (in memory; resumed from disk on boot). Only ever
	// incremented, single-threaded, so seqs are unique and monotonic for the run.
	seq: number;
	// Highest seq durably written to disk, so a cursor read reports a floor that
	// matches what a consumer can actually fetch (never ahead of the file).
	written: number;
	// Live counters for the current file, so rotation decides without a stat/read
	// per append. Seeded from disk at boot.
	bytes: number;
	lines: number;
	// Per-file append chain: each write waits for the previous, so a rotation can't
	// interleave with an append (mirrors transcript-writer's ordering).
	tail: Promise<unknown>;
}

// Survive HMR in dev so producers and the counter share one state.
const g = globalThis as { __deckEventLogState?: LogState };
const state = (g.__deckEventLogState ??= initState());

function safeRead(file: string): string {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

function initState(): LogState {
	const current = safeRead(eventLogFile);
	// Resume the counter from the newest retained seq: the current file's max, or
	// the just-rotated generation's if the current file is empty (fresh after a
	// rotation, or a brand-new install).
	let seq = maxSeq(current);
	if (seq === 0) seq = maxSeq(safeRead(ROTATED));
	return {
		seq,
		written: seq,
		bytes: Buffer.byteLength(current),
		lines: countLines(current),
		tail: Promise.resolve()
	};
}

// Queue a durable append for one event. Never blocks the caller and never throws
// (a failed write is logged, like the old emit): a producer publishing from a
// .finally continuation must not see an error. The `seq` is assigned inside the
// ordered write, not at call time, and only *committed* (state.seq advanced) once
// the line is on disk — so a failed write drops a single delta rather than
// consuming a seq and leaving an undetectable hole in the log (readCursor only
// spots a missing prefix, not an internal gap). On success the caller's event
// object is stamped with the committed `seq`, so it can emit the live event
// (once durable) carrying the same value the log line has. `seq` stays 0 on
// failure, the signal to skip the emit.
export function appendEventLog(event: SeqEvent): Promise<void> {
	const write = state.tail.then(async () => {
		// Tentative until the write lands: reuse this number on the next event if
		// this one fails, keeping on-disk seqs contiguous.
		const seq = state.seq + 1;
		const line = serializeEventLine({ ...event, seq });
		const len = Buffer.byteLength(line);
		try {
			if (shouldRotate(state.bytes, state.lines, len)) {
				// Rename overwrites the previous generation; a live tailer following the
				// old inode keeps reading it, so no event is lost mid-rotation.
				await fs.promises.rename(eventLogFile, ROTATED);
				state.bytes = 0;
				state.lines = 0;
			}
			await fs.promises.appendFile(eventLogFile, line);
			state.bytes += len;
			state.lines += 1;
			state.seq = seq;
			state.written = seq;
			event.seq = seq;
		} catch (err) {
			console.error('[deck] event log append failed:', err);
		}
	});
	// Swallow on the stored tail so one failed write can't wedge the chain; the
	// returned promise still reflects completion for ordering the emit.
	state.tail = write.catch(() => {});
	return write;
}

// The highest seq durably on disk — the cursor floor a bootstrap/gap response
// reports. Never ahead of the file, so a consumer that resumes from it can always
// fetch what follows.
export function currentLogSeq(): number {
	return state.written;
}

// Resolve once the queued appends have settled. Tests await this before removing
// a throwaway data dir, so a still-pending append can't fail (and log) mid worker
// teardown; production has no reason to call it (appends are fire-and-forget).
export function whenEventLogDrained(): Promise<void> {
	return Promise.resolve(state.tail).then(() => {});
}

export interface CursorRead {
	gap: boolean;
	events: SeqEvent[];
	seq: number;
}

// Read the log as a cursor: events strictly after `since`, plus the current max
// seq. When `since` predates the retained window (rotated away), returns gap:true
// with no events so the caller re-snapshots. Reads both generations off disk (the
// rotated .1 holds the older, contiguous half), so it is restart-safe.
export function readCursor(since: number): CursorRead {
	const events = [
		...parseEventLines(safeRead(ROTATED)),
		...parseEventLines(safeRead(eventLogFile))
	];
	const oldest = events.length ? events[0].seq : undefined;
	const latest = events.length ? events[events.length - 1].seq : state.written;
	if (isGap(since, oldest)) return { gap: true, events: [], seq: latest };
	return { gap: false, events: eventsAfter(events, since), seq: latest };
}
