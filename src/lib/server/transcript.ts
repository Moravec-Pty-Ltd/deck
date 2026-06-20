import fs from 'node:fs';
import path from 'node:path';
import { transcriptsDir } from './config';

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
	return cacheIndex(id, buildIndex(file, stat, indexCache.get(id)));
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

// Store as most-recently-used and evict the oldest entries past the cap.
function cacheIndex(id: string, index: TranscriptIndex): TranscriptIndex {
	indexCache.delete(id);
	indexCache.set(id, index);
	while (indexCache.size > INDEX_CACHE_MAX) {
		const oldest = indexCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		indexCache.delete(oldest);
	}
	return index;
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
function readTranscriptTail(id: string): { total: number; start: number; events: unknown[] } {
	const index = transcriptIndex(id);
	if (!index) return { total: 0, start: 0, events: [] };
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
	return { total, start, events };
}

// The recent-history snapshot split into small frames the client reassembles by
// `seq`. One big SSE frame doesn't reliably flush through the dev server when the
// stream opens amid the page-load request burst; ~32KB frames deliver like the
// old per-line replay did.
export function snapshotFrames(id: string): { seq: number; n: number; data: string }[] {
	const tail = readTranscriptTail(id);
	const payload = JSON.stringify({ start: tail.start, total: tail.total, events: tail.events });
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
