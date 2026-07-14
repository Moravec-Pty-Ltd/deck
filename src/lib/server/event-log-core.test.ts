import { describe, it, expect } from 'vitest';
import {
	countLines,
	eventsAfter,
	isGap,
	maxSeq,
	parseEventLine,
	parseEventLines,
	parseSince,
	parseWait,
	serializeEventLine,
	shouldRotate,
	type SeqEvent
} from './event-log-core';

const ev = (seq: number, over: Record<string, unknown> = {}): SeqEvent => ({
	seq,
	sessionId: 'c_1',
	type: 'status',
	at: 0,
	...over
});

describe('serialize / parse', () => {
	it('round-trips an event through a log line', () => {
		const line = serializeEventLine(ev(3, { status: 'idle' }));
		expect(line.endsWith('\n')).toBe(true);
		expect(parseEventLine(line)).toMatchObject({ seq: 3, status: 'idle' });
	});

	it('drops blank, unparseable, and seq-less lines', () => {
		expect(parseEventLine('')).toBeNull();
		expect(parseEventLine('   ')).toBeNull();
		expect(parseEventLine('{not json')).toBeNull();
		expect(parseEventLine('{"sessionId":"c_1"}')).toBeNull();
	});

	it('parses a file, skipping a torn trailing line', () => {
		const text = serializeEventLine(ev(1)) + serializeEventLine(ev(2)) + '{"seq":3,"par';
		const events = parseEventLines(text);
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
	});
});

describe('maxSeq / countLines', () => {
	it('resumes from the highest seq, ignoring a torn tail', () => {
		const text = serializeEventLine(ev(7)) + serializeEventLine(ev(8)) + '{"seq":9,part';
		expect(maxSeq(text)).toBe(8);
	});

	it('is 0 for an empty log', () => {
		expect(maxSeq('')).toBe(0);
	});

	it('counts only newline-terminated lines', () => {
		expect(countLines(serializeEventLine(ev(1)) + serializeEventLine(ev(2)) + 'partial')).toBe(2);
	});
});

describe('cursor filter and gap', () => {
	const events = [ev(5), ev(6), ev(7)];

	it('returns only events strictly after the cursor', () => {
		expect(eventsAfter(events, 6).map((e) => e.seq)).toEqual([7]);
		expect(eventsAfter(events, 7)).toEqual([]);
		expect(eventsAfter(events, 4).map((e) => e.seq)).toEqual([5, 6, 7]);
	});

	it('flags a gap only when the cursor predates the retained window', () => {
		// oldest retained is 5: a cursor at 4 wants 5.. (contiguous, no gap).
		expect(isGap(4, 5)).toBe(false);
		// a cursor at 3 wanted 4, which has been rotated away → gap.
		expect(isGap(3, 5)).toBe(true);
		// caught-up cursor, no gap.
		expect(isGap(7, 5)).toBe(false);
		// empty log is never a gap.
		expect(isGap(100, undefined)).toBe(false);
	});
});

describe('query parsing', () => {
	it('accepts a non-negative integer since, rejects the rest', () => {
		expect(parseSince('0')).toBe(0);
		expect(parseSince('42')).toBe(42);
		expect(parseSince(null)).toBeNull();
		expect(parseSince('-1')).toBeNull();
		expect(parseSince('1.5')).toBeNull();
		expect(parseSince('abc')).toBeNull();
	});

	it('reads truthy wait flags', () => {
		expect(parseWait('1')).toBe(true);
		expect(parseWait('true')).toBe(true);
		expect(parseWait('0')).toBe(false);
		expect(parseWait(null)).toBe(false);
	});
});

describe('rotation threshold', () => {
	it('never rotates an empty current file', () => {
		expect(shouldRotate(0, 0, 100)).toBe(false);
	});

	it('rotates when the byte cap would be exceeded', () => {
		expect(shouldRotate(10, 1, 5, 12)).toBe(true);
		expect(shouldRotate(10, 1, 1, 12)).toBe(false);
	});

	it('rotates when the line cap would be exceeded', () => {
		expect(shouldRotate(0, 5, 1, 1000, 5)).toBe(true); // lines+1 = 6 > 5
		expect(shouldRotate(0, 4, 1, 1000, 5)).toBe(false); // lines+1 = 5, within cap
	});
});
