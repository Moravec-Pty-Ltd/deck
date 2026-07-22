import { describe, expect, it } from 'vitest';
import { parseEffort } from './session-effort-core';

describe('parseEffort', () => {
	it('treats an absent effort as a reset', () => {
		expect(parseEffort(undefined)).toEqual({ ok: true, effort: undefined });
	});

	it('treats an empty or whitespace-only effort as a reset', () => {
		expect(parseEffort('')).toEqual({ ok: true, effort: undefined });
		expect(parseEffort('   ')).toEqual({ ok: true, effort: undefined });
	});

	it('trims and keeps a known effort level', () => {
		expect(parseEffort('  high  ')).toEqual({ ok: true, effort: 'high' });
		for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
			expect(parseEffort(level)).toEqual({ ok: true, effort: level });
		}
	});

	it('rejects an unknown effort level', () => {
		expect(parseEffort('ultra')).toEqual({ ok: false });
		expect(parseEffort('High')).toEqual({ ok: false });
		expect(parseEffort('none')).toEqual({ ok: false });
	});

	it('rejects a non-string effort', () => {
		expect(parseEffort(42)).toEqual({ ok: false });
		expect(parseEffort(null)).toEqual({ ok: false });
		expect(parseEffort({ effort: 'high' })).toEqual({ ok: false });
	});
});
