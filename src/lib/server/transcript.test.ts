import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the data dir at a throwaway tmpdir before importing the module so its
// config side effects (mkdir) and every transcript read/write land there.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-transcript-test-'));
process.env.DECK_DATA = dataDir;

const { transcriptPath, snapshotFrames, readTranscriptRange } = await import('./transcript');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// Write events as the app does: one JSON object per line, appended.
function seed(id: string, events: unknown[]) {
	fs.writeFileSync(transcriptPath(id), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
function append(id: string, events: unknown[]) {
	fs.appendFileSync(transcriptPath(id), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// Reassemble the snapshot payload the SSE endpoint would emit from the frames.
function snapshot(id: string): { start: number; total: number; events: unknown[] } {
	const frames = snapshotFrames(id);
	expect(frames.every((f, i) => f.seq === i && f.n === frames.length)).toBe(true);
	return JSON.parse(frames.map((f) => f.data).join(''));
}

const ev = (i: number, extra: Record<string, unknown> = {}) => ({ type: 'x', i, ...extra });

describe('snapshotFrames tail', () => {
	it('returns the whole transcript when it is small', () => {
		const id = 'small';
		const events = [ev(0), ev(1), ev(2)];
		seed(id, events);
		expect(snapshot(id)).toEqual({ start: 0, total: 3, events });
	});

	it('caps the tail by event count and reports the true total', () => {
		const id = 'manycount';
		const events = Array.from({ length: 600 }, (_, i) => ev(i));
		seed(id, events);
		const snap = snapshot(id);
		expect(snap.total).toBe(600);
		expect(snap.events.length).toBe(250); // SNAPSHOT_MAX
		expect(snap.start).toBe(350);
		expect(snap.events).toEqual(events.slice(350));
	});

	it('caps the tail by serialized bytes, always keeping at least the newest', () => {
		const id = 'manybytes';
		// Each event ~2KB; 200 of them dwarfs the 256KB byte budget before the
		// count cap bites, so the byte cap decides the tail.
		const big = 'z'.repeat(2000);
		const events = Array.from({ length: 200 }, (_, i) => ev(i, { big }));
		seed(id, events);
		const snap = snapshot(id);
		expect(snap.total).toBe(200);
		expect(snap.events.length).toBeGreaterThan(0);
		expect(snap.events.length).toBeLessThan(200);
		expect(snap.start).toBe(200 - snap.events.length);
		// Whatever made it in is the contiguous newest run, ending at the last event.
		expect(snap.events).toEqual(events.slice(snap.start));
	});

	it('returns empty for a missing transcript', () => {
		expect(snapshot('does-not-exist')).toEqual({ start: 0, total: 0, events: [] });
	});

	it('keeps a placeholder for a malformed line so indices stay 1:1 with lines', () => {
		const id = 'malformed';
		fs.writeFileSync(transcriptPath(id), JSON.stringify(ev(0)) + '\n' + 'not json\n' + JSON.stringify(ev(2)) + '\n');
		const snap = snapshot(id);
		expect(snap.total).toBe(3); // three physical lines indexed
		// The bad line holds its slot (events stay aligned with absolute indices)
		// rather than collapsing the slice and shifting ev(2) down one.
		expect(snap.events).toEqual([ev(0), { type: 'deck.unreadable' }, ev(2)]);
	});
});

describe('incremental index across appends', () => {
	it('reflects newly appended events on the next read', () => {
		const id = 'growing';
		seed(id, [ev(0), ev(1)]);
		expect(snapshot(id)).toEqual({ start: 0, total: 2, events: [ev(0), ev(1)] });
		append(id, [ev(2), ev(3)]);
		expect(snapshot(id)).toEqual({ start: 0, total: 4, events: [ev(0), ev(1), ev(2), ev(3)] });
	});

	it('rescans only the appended bytes, not the whole file, when the index is warm', () => {
		const id = 'growing-large';
		// Many small events so the 250-event tail is a fraction of the file: a read
		// bounded to the tail (plus a scan of just the appended bytes) is provably
		// smaller than one full pass, which a naive rebuild-then-slice would cost.
		seed(id, Array.from({ length: 2000 }, (_, i) => ev(i)));
		snapshot(id); // warm the index
		const fileSize = fs.statSync(transcriptPath(id)).size;

		const readSpy = vi.spyOn(fs, 'readSync');
		append(id, [ev(2000), ev(2001)]);
		const snap = snapshot(id);
		const bytesRead = readSpy.mock.results.reduce(
			(n, r) => n + (typeof r.value === 'number' ? r.value : 0),
			0
		);
		readSpy.mockRestore();

		expect(snap.total).toBe(2002); // the appended events are indexed...
		expect(snap.events.at(-1)).toEqual(ev(2001)); // ...and served in the tail
		expect(bytesRead).toBeLessThan(fileSize); // never re-read the whole history
	});

	it('reuses the cached index when the file is unchanged', () => {
		const id = 'cached';
		seed(id, [ev(0), ev(1), ev(2)]);
		snapshot(id); // warms the index

		const openSpy = vi.spyOn(fs, 'openSync');
		snapshot(id); // unchanged → only the slice read, no rescan
		// One open for the returned-slice read; the index scan is skipped entirely.
		const opensForThisFile = openSpy.mock.calls.filter(
			(c) => c[0] === transcriptPath(id)
		).length;
		openSpy.mockRestore();
		expect(opensForThisFile).toBe(1);
	});
});

describe('readTranscriptRange back-scroll', () => {
	const id = 'range';
	const events = Array.from({ length: 100 }, (_, i) => ev(i));
	seed(id, events);

	it('returns the contiguous slice [start, before) oldest-first', () => {
		expect(readTranscriptRange(id, 50, 20)).toEqual({ start: 30, events: events.slice(30, 50) });
	});

	it('clamps before to the total and start to zero', () => {
		expect(readTranscriptRange(id, 1000, 10)).toEqual({ start: 90, events: events.slice(90) });
		expect(readTranscriptRange(id, 5, 50)).toEqual({ start: 0, events: events.slice(0, 5) });
	});

	it('returns empty at the start of history', () => {
		expect(readTranscriptRange(id, 0, 20)).toEqual({ start: 0, events: [] });
	});

	it('returns empty for a missing transcript', () => {
		expect(readTranscriptRange('nope', 10, 10)).toEqual({ start: 0, events: [] });
	});

	it('coerces fractional before/limit to integers instead of throwing', () => {
		// A non-integer index would land mid-line and blow up the byte math; it
		// must floor cleanly the way the old slice-based reader did.
		expect(readTranscriptRange(id, 50.7, 20.9)).toEqual({ start: 30, events: events.slice(30, 50) });
		expect(readTranscriptRange(id, NaN, NaN)).toEqual({ start: 0, events: [] });
	});

	it('caps an oversized limit so the slice stays bounded', () => {
		const big = 'caps';
		const many = Array.from({ length: 1500 }, (_, i) => ev(i));
		seed(big, many);
		// limit far past RANGE_MAX (1000) must not read from index 0; the span is
		// capped to the most recent 1000 before `before`.
		const slice = readTranscriptRange(big, 1500, 1_000_000);
		expect(slice.start).toBe(500);
		expect(slice.events).toEqual(many.slice(500));
	});
});
