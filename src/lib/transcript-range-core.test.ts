import { describe, expect, it } from 'vitest';
import { parseTranscriptRange, RANGE_DEFAULT, RANGE_MAX } from './transcript-range-core';

const parse = (query: string) => parseTranscriptRange(new URLSearchParams(query));

describe('parseTranscriptRange', () => {
	it('reads before and limit as given', () => {
		expect(parse('before=500&limit=250')).toEqual({ before: 500, limit: 250 });
	});

	it('defaults a missing before to the end and a missing limit to a page', () => {
		expect(parse('')).toEqual({ before: Number.MAX_SAFE_INTEGER, limit: RANGE_DEFAULT });
	});

	it('treats an empty, negative or non-numeric before as the end', () => {
		for (const q of ['before=', 'before=-3', 'before=abc', 'before=Infinity']) {
			expect(parse(q).before).toBe(Number.MAX_SAFE_INTEGER);
		}
	});

	it('keeps before=0 (the start of the transcript)', () => {
		expect(parse('before=0').before).toBe(0);
	});

	it('floors fractional values', () => {
		expect(parse('before=10.9&limit=5.5')).toEqual({ before: 10, limit: 5 });
	});

	it('clamps limit to RANGE_MAX', () => {
		expect(parse('limit=1000000').limit).toBe(RANGE_MAX);
	});

	it('falls back to a page for a zero, negative or junk limit', () => {
		for (const q of ['limit=0', 'limit=-1', 'limit=x', 'limit=0.4']) {
			expect(parse(q).limit).toBe(RANGE_DEFAULT);
		}
	});
});
