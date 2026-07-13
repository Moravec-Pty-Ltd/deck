// Pure logic for deck's durable agent event log (issue #143): the append-only,
// monotonically-sequenced JSONL at ~/.deck/events.jsonl. This module owns the
// serialize/parse of a log line, the "events after a cursor" filter, the gap
// (too-old cursor) test, and the rotation threshold, all node-free so they unit
// test without touching the filesystem. The fs/counter wiring lives in
// event-log.ts.

// One logged event. `seq` is the global monotonic cursor; the rest mirrors the
// in-memory AgentFeedEvent (sessionId / type / at + payload). Kept structural so
// the core needn't import the server-side event union.
export interface SeqEvent {
	seq: number;
	[key: string]: unknown;
}

// Serialize one event to a log line (trailing newline included) so an append is a
// single write.
export function serializeEventLine(event: SeqEvent): string {
	return JSON.stringify(event) + '\n';
}

// Parse one log line into a SeqEvent, or null when it is blank, unparseable, or
// carries no numeric seq (a torn/partial trailing write, or a foreign line).
export function parseEventLine(line: string): SeqEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const obj = JSON.parse(trimmed) as { seq?: unknown };
		if (obj && typeof obj === 'object' && typeof obj.seq === 'number') return obj as SeqEvent;
	} catch {
		// unreadable line: drop it
	}
	return null;
}

// Parse a whole log file's text into events, ascending order preserved, invalid
// lines dropped.
export function parseEventLines(text: string): SeqEvent[] {
	const out: SeqEvent[] = [];
	for (const line of text.split('\n')) {
		const ev = parseEventLine(line);
		if (ev) out.push(ev);
	}
	return out;
}

// The highest seq present in a log file's text, or 0 when it holds no valid line.
// Used to resume the counter on boot: the log is append-only so the max is near
// the tail, but a torn last line means we can't just read the final line.
export function maxSeq(text: string): number {
	let max = 0;
	for (const ev of parseEventLines(text)) if (ev.seq > max) max = ev.seq;
	return max;
}

// Number of newline-terminated lines in the text (what the rotation line-cap
// counts); a trailing partial line without a newline isn't counted.
export function countLines(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

// Events strictly after the cursor.
export function eventsAfter(events: SeqEvent[], since: number): SeqEvent[] {
	return events.filter((e) => e.seq > since);
}

// A cursor is "too old" (its next expected event has been rotated away) when the
// oldest retained event is newer than since+1, i.e. events since+1..oldest-1 are
// gone. An empty log (oldest undefined) is never a gap: there is simply nothing
// after the cursor yet.
export function isGap(since: number, oldestSeq: number | undefined): boolean {
	return oldestSeq !== undefined && since + 1 < oldestSeq;
}

// Parse a ?since= query value into a non-negative integer cursor, or null when it
// is absent/malformed, so the caller 400s rather than silently treating a typo as
// 0 and replaying the whole log.
export function parseSince(raw: string | null): number | null {
	if (raw === null) return null;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

// Truthy ?wait= values that opt a cursor read into long-poll.
export function parseWait(raw: string | null): boolean {
	return raw === '1' || raw === 'true';
}

// Default rotation bounds: rotate the live log once it would exceed either cap,
// keeping one previous generation (events.jsonl.1). Chosen so the retained window
// (both generations) stays a few MB / tens of thousands of events: comfortably
// more than a restart-resume needs, but bounded so the file can't grow forever.
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LOG_LINES = 20_000;

// Whether appending a line of `nextLen` bytes should trigger a rotation first.
// Never rotates an empty current file (nothing to preserve, and it would drop the
// previous generation for no reason).
export function shouldRotate(
	bytes: number,
	lines: number,
	nextLen: number,
	maxBytes = MAX_LOG_BYTES,
	maxLines = MAX_LOG_LINES
): boolean {
	if (lines === 0) return false;
	return bytes + nextLen > maxBytes || lines + 1 > maxLines;
}
