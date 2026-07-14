import fs from 'node:fs';
import path from 'node:path';
import { transcriptsDir } from './config';
import { emptyCostSummary, foldResult, type CostSummary } from '$lib/session-cost-core';
import { projectTranscript, type TranscriptMessage } from '$lib/agent-transcript-core';

// Transcript files are append-only JSONL: one JSON event per line, written by
// appendEvent. The live view only ever needs the tail (initial snapshot) or a
// bounded older slice (back-scroll), never the whole history. Reading and
// JSON.parse-ing every line of a multi-megabyte file on each SSE connect blocked
// the event loop, repeated on every reconnect. Instead we keep a per-session
// index of line boundaries (just the newline byte offsets), cached and extended
// incrementally as the file grows, then read and parse only the byte range a
// request actually returns.

export function transcriptPath(id: string) {
	return path.join(transcriptsDir, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
}

interface TranscriptIndex {
	// File size and mtime the index was built for: an unchanged stat means the
	// cached index is still valid; a larger size means only the appended bytes
	// need scanning.
	size: number;
	mtimeMs: number;
	// Absolute byte offset of every '\n', one entry per complete line. Line i
	// occupies [lineStart(i), newlines[i]]; lineStart(0) = 0 and
	// lineStart(i) = newlines[i-1] + 1.
	newlines: number[];
}

// Bounded LRU of per-session indexes. Each is small (one number per line) but an
// unbounded map would pin every session ever opened in this process.
const INDEX_CACHE_MAX = 64;
const indexCache = new Map<string, TranscriptIndex>();

function transcriptIndex(id: string): TranscriptIndex | null {
	const file = transcriptPath(id);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		indexCache.delete(id);
		return null;
	}
	return lruSet(indexCache, id, buildIndex(file, stat, indexCache.get(id)));
}

// Reuse the cached index when the stat is unchanged; extend it in place when the
// file only grew (append-only, so old offsets still hold); otherwise rebuild.
function buildIndex(
	file: string,
	stat: fs.Stats,
	cached: TranscriptIndex | undefined
): TranscriptIndex {
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
	const grew = !!cached && stat.size > cached.size;
	const newlines = grew ? cached!.newlines : [];
	const base = newlines.length;
	try {
		scanNewlines(file, grew ? cached!.size : 0, stat.size, newlines);
	} catch (err) {
		// A mid-scan I/O error must not leave the reused array half-extended while
		// the cached entry's size/mtime stay stale: the next call would rescan from
		// the old size and double-append. Roll back to the pre-scan length, rethrow.
		newlines.length = base;
		throw err;
	}
	return { size: stat.size, mtimeMs: stat.mtimeMs, newlines };
}

// Store as most-recently-used and evict the oldest entries past the cap. Shared
// by the newline index and the cost summary, which are cached the same way.
function lruSet<T>(cache: Map<string, T>, id: string, entry: T): T {
	cache.delete(id);
	cache.set(id, entry);
	while (cache.size > INDEX_CACHE_MAX) {
		const oldest = cache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return entry;
}

// Append the byte offset of every '\n' in [from, to) to `newlines`, reading in
// bounded chunks so a huge transcript never forces one giant allocation.
function scanNewlines(file: string, from: number, to: number, newlines: number[]) {
	if (to <= from) return;
	const fd = fs.openSync(file, 'r');
	try {
		const CHUNK = 1 << 20; // 1 MiB
		const buf = Buffer.allocUnsafe(Math.min(CHUNK, to - from));
		let pos = from;
		while (pos < to) {
			const read = readFull(fd, buf, pos, Math.min(buf.length, to - pos));
			if (read <= 0) break;
			for (let i = 0; i < read; i++) {
				if (buf[i] === 0x0a) newlines.push(pos + i);
			}
			pos += read;
		}
	} finally {
		fs.closeSync(fd);
	}
}

// Read `count` events from the byte range [from, to), one JSON object per line,
// oldest-first. Callers pass the exact line count the index says this range
// holds: the client treats events[k] as absolute index start+k and its
// back-scroll math assumes one event per line, so the result must stay 1:1 with
// the lines even when a line is unreadable (corrupt/blank) — such a line keeps
// its slot as a placeholder the view renders as nothing, rather than collapsing
// the slice and shifting every later index.
function readEvents(file: string, from: number, to: number, count: number): unknown[] {
	if (count <= 0 || to <= from) return [];
	let fd: number;
	try {
		fd = fs.openSync(file, 'r');
	} catch {
		return [];
	}
	try {
		const buf = Buffer.allocUnsafe(to - from);
		const read = readFull(fd, buf, from, to - from);
		const lines = buf.toString('utf8', 0, read).split('\n');
		const events: unknown[] = new Array(count);
		for (let k = 0; k < count; k++) {
			try {
				events[k] = JSON.parse(lines[k]);
			} catch {
				events[k] = { type: 'deck.unreadable' };
			}
		}
		return events;
	} finally {
		fs.closeSync(fd);
	}
}

// Fill `buf` from `fd` starting at file offset `pos`, looping until it is full or
// EOF (a single readSync may return a short count). Returns the bytes read.
function readFull(fd: number, buf: Buffer, pos: number, length: number): number {
	let read = 0;
	while (read < length) {
		const n = fs.readSync(fd, buf, read, length - read, pos + read);
		if (n <= 0) break;
		read += n;
	}
	return read;
}

// Byte offset where line `i` begins (0 <= i <= total); lineStart(total) is the
// end of the last complete line.
function lineStart(newlines: number[], i: number): number {
	return i === 0 ? 0 : newlines[i - 1] + 1;
}

// Initial snapshot for the live view: only the most recent events, bounded by
// both count and serialized size. Long coding sessions accumulate megabytes of
// tool output; shipping the whole transcript in one SSE frame
// blocks first paint (and the live stream behind it) for seconds on mobile.
// Older history loads lazily via the /transcript endpoint when scrolled to.
const SNAPSHOT_MAX = 250;
const SNAPSHOT_BYTES = 256 * 1024;
function readTranscriptTail(id: string): {
	total: number;
	start: number;
	cost: CostSummary;
	events: unknown[];
} {
	const index = transcriptIndex(id);
	if (!index) return { total: 0, start: 0, cost: emptyCostSummary(), events: [] };
	const { newlines } = index;
	const total = newlines.length;

	let bytes = 0;
	let start = total;
	// Walk back from the newest line, measuring each from the index (no parse)
	// before testing the caps, so the newest line always makes it in even alone.
	while (start > 0) {
		bytes += lineStart(newlines, start) - lineStart(newlines, start - 1);
		start--;
		if (total - start >= SNAPSHOT_MAX) break;
		if (bytes > SNAPSHOT_BYTES) break;
	}
	const events = readEvents(
		transcriptPath(id),
		lineStart(newlines, start),
		lineStart(newlines, total),
		total - start
	);
	// Cost over the whole transcript, folded from the same index this tail was
	// built on, so the two stay anchored to one line count (see costSummaryFromIndex).
	return { total, start, cost: costSummaryFromIndex(id, index), events };
}

// The serialized tail of the transcript (newest SNAPSHOT_MAX events / bytes), as
// one string, for a bounded one-time scan such as the PR-link backfill on
// session open. Re-stringifying the parsed tail keeps any embedded URL intact;
// the bound caps the work regardless of how long the session ran.
export function readTranscriptTailText(id: string): string {
	return readTranscriptTail(id)
		.events.map((e) => JSON.stringify(e))
		.join('\n');
}

// The session's most recent assistant reply (bounded to the snapshot tail), or
// null when it has produced no text yet. Cheap enough to attach to a
// single-session digest's `lastResult` (issue #144).
export function sessionLastResult(id: string): string | null {
	return projectTranscript(readTranscriptTail(id).events).lastResult;
}

// Readable, projected turn output for the agent transcript endpoint (issue #144):
// the recent user/assistant messages, the last assistant reply, and the running
// cost — what an orchestrator reads to see what a session actually said.
export function agentTranscriptView(id: string): {
	messages: TranscriptMessage[];
	lastResult: string | null;
	cost: CostSummary;
} {
	const tail = readTranscriptTail(id);
	const projected = projectTranscript(tail.events);
	return { messages: projected.messages, lastResult: projected.lastResult, cost: tail.cost };
}

// Running cost/turns/duration total over the whole transcript, kept per session
// so the client can pin a session-level figure the snapshot's recent-history
// window can't hold. Result events are tiny and one per turn, so we fold only
// small result-marked lines (skipping large tool-output lines unread) using the
// newline index's line boundaries, and extend the summary as the file grows,
// mirroring how the index itself is cached and extended incrementally.
interface CostIndex {
	size: number;
	mtimeMs: number;
	lines: number;
	summary: CostSummary;
}
const costCache = new Map<string, CostIndex>();
// A result event is a flat object (~10KB at most in practice); anything larger
// is a different event (tool output) and can't be a result, so skip it unread.
const RESULT_LINE_MAX = 64 * 1024;

export function transcriptCostSummary(id: string): CostSummary {
	const index = transcriptIndex(id);
	if (!index) {
		costCache.delete(id);
		return emptyCostSummary();
	}
	return costSummaryFromIndex(id, index);
}

// Fold the transcript's result events into a running total, cached against and
// extended alongside the given index. Callers pass the same index they read the
// rest of the snapshot from, so the cost and the events tail stay anchored to one
// line count: a second, independent index read could otherwise pick up a result
// the tail doesn't carry, and the client would fold that streamed result twice.
function costSummaryFromIndex(id: string, index: TranscriptIndex): CostSummary {
	const total = index.newlines.length;
	const cached = costCache.get(id);
	if (cached && cached.size === index.size && cached.mtimeMs === index.mtimeMs) return cached.summary;
	// Append-only, so a size increase just extends from the last folded line
	// (mtime has usually changed too); anything else (truncation, rewrite from a
	// smaller/equal size) rebuilds from the start.
	const grew = !!cached && index.size > cached.size && cached.lines <= total;
	const summary = foldResultLines(
		transcriptPath(id),
		index.newlines,
		grew ? cached!.lines : 0,
		total,
		grew ? cached!.summary : emptyCostSummary()
	);
	return lruSet(costCache, id, {
		size: index.size,
		mtimeMs: index.mtimeMs,
		lines: total,
		summary
	}).summary;
}

// Fold the `result` events in lines [from, to) into `summary`. Reads each small
// line individually so a huge tool-output line never pulls megabytes into
// memory; the marker pre-filter avoids parsing lines that can't be results, and
// foldResult re-checks the parsed type so a false-positive match is harmless.
function foldResultLines(
	file: string,
	newlines: number[],
	from: number,
	to: number,
	summary: CostSummary
): CostSummary {
	if (to <= from) return summary;
	let fd: number;
	try {
		fd = fs.openSync(file, 'r');
	} catch {
		return summary;
	}
	try {
		for (let i = from; i < to; i++) {
			const s = lineStart(newlines, i);
			const len = newlines[i] - s;
			if (len <= 0 || len > RESULT_LINE_MAX) continue;
			const buf = Buffer.allocUnsafe(len);
			const read = readFull(fd, buf, s, len);
			const line = buf.toString('utf8', 0, read);
			if (!line.includes('"type":"result"')) continue;
			try {
				summary = foldResult(summary, JSON.parse(line));
			} catch {
				// Unreadable/partial line: skip it, same as the transcript reader.
			}
		}
	} finally {
		fs.closeSync(fd);
	}
	return summary;
}

// The recent-history snapshot split into small frames the client reassembles by
// `seq`. One big SSE frame doesn't reliably flush through the dev server when the
// stream opens amid the page-load request burst; ~32KB frames deliver like the
// old per-line replay did.
export function snapshotFrames(id: string): { seq: number; n: number; data: string }[] {
	const tail = readTranscriptTail(id);
	const payload = JSON.stringify({
		start: tail.start,
		total: tail.total,
		cost: tail.cost,
		events: tail.events
	});
	const CHUNK = 32 * 1024;
	const n = Math.max(1, Math.ceil(payload.length / CHUNK));
	const frames = [];
	for (let i = 0; i < n; i++)
		frames.push({ seq: i, n, data: payload.slice(i * CHUNK, (i + 1) * CHUNK) });
	return frames;
}

// Upper bound on a single back-scroll request, well above the client's
// HYDRATE_CHUNK (250). Without it a crafted ?limit= could read and parse from
// index 0 on the request thread, the unbounded read this module exists to avoid.
const RANGE_MAX = 1000;

// A contiguous older slice [start, end) for lazy back-scroll, oldest-first.
export function readTranscriptRange(
	id: string,
	before: number,
	limit: number
): { start: number; events: unknown[] } {
	const index = transcriptIndex(id);
	if (!index) return { start: 0, events: [] };
	const total = index.newlines.length;
	// Coerce to integers: query params arrive as arbitrary numbers and a
	// fractional index would land between lines and break the byte math. Cap the
	// span so the slice stays bounded regardless of the requested limit.
	const before0 = Number.isFinite(before) ? Math.floor(before) : 0;
	const limit0 = Math.min(Number.isFinite(limit) ? Math.floor(limit) : 0, RANGE_MAX);
	const end = Math.max(0, Math.min(before0, total));
	const start = Math.max(0, end - Math.max(0, limit0));
	const events = readEvents(
		transcriptPath(id),
		lineStart(index.newlines, start),
		lineStart(index.newlines, end),
		end - start
	);
	return { start, events };
}
