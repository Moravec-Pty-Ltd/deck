import { describe, expect, it } from 'vitest';
import {
	emptyCostSummary,
	foldResult,
	formatCostSummary,
	formatDuration,
	sessionCostSummary
} from './session-cost-core';

const result = (o: Record<string, unknown>) => ({ type: 'result', ...o });

describe('sessionCostSummary', () => {
	it('sums cost, turns and duration across every result (per-turn figures)', () => {
		const events = [
			{ type: 'assistant', message: {} },
			result({ total_cost_usd: 0.01, num_turns: 3, duration_ms: 18400 }),
			{ type: 'user', message: {} },
			result({ total_cost_usd: 0.41, num_turns: 9, duration_ms: 239600 })
		];
		expect(sessionCostSummary(events)).toEqual({
			costUsd: 0.42,
			turns: 12,
			durationMs: 258000,
			results: 2
		});
	});

	it('ignores non-result events and returns an empty summary for none', () => {
		expect(sessionCostSummary([])).toEqual(emptyCostSummary());
		expect(
			sessionCostSummary([{ type: 'assistant' }, { type: 'tool_use' }, { type: 'stream_event' }])
		).toEqual(emptyCostSummary());
	});

	it('counts a result as one turn when num_turns is absent', () => {
		const events = [result({ total_cost_usd: 0 }), result({ total_cost_usd: 0 })];
		expect(sessionCostSummary(events)).toMatchObject({ turns: 2, results: 2, costUsd: 0 });
	});

	it('treats missing or non-numeric figures as zero', () => {
		const events = [result({}), result({ total_cost_usd: 'x', duration_ms: null, num_turns: 2 })];
		expect(sessionCostSummary(events)).toEqual({
			costUsd: 0,
			turns: 3,
			durationMs: 0,
			results: 2
		});
	});

	it('keeps turns finite when num_turns is NaN or Infinity, counting the result once', () => {
		const events = [result({ num_turns: NaN }), result({ num_turns: Infinity })];
		expect(sessionCostSummary(events)).toMatchObject({ turns: 2, results: 2 });
	});
});

describe('foldResult', () => {
	it('returns the same summary object for a non-result event', () => {
		const sum = emptyCostSummary();
		expect(foldResult(sum, { type: 'assistant' })).toBe(sum);
		expect(foldResult(sum, null)).toBe(sum);
	});
});

describe('formatDuration', () => {
	it('shows seconds under a minute, m/s under an hour, h/m beyond', () => {
		expect(formatDuration(258000)).toBe('4m 18s');
		expect(formatDuration(18400)).toBe('18s');
		expect(formatDuration(3_930_000)).toBe('1h 5m');
		expect(formatDuration(0)).toBe('0s');
	});

	it('rounds to the nearest second without a 60s overflow', () => {
		expect(formatDuration(59_600)).toBe('1m 0s');
	});
});

describe('formatCostSummary', () => {
	it('renders cost, turns and duration', () => {
		expect(
			formatCostSummary({ costUsd: 0.42, turns: 12, durationMs: 258000, results: 2 })
		).toBe('$0.42 · 12 turns · 4m 18s');
	});

	it('drops the $ segment when there is no cost', () => {
		expect(formatCostSummary({ costUsd: 0, turns: 5, durationMs: 12000, results: 5 })).toBe(
			'5 turns · 12s'
		);
	});

	it('drops the duration segment when no result carried one', () => {
		expect(formatCostSummary({ costUsd: 0.03, turns: 4, durationMs: 0, results: 4 })).toBe(
			'$0.03 · 4 turns'
		);
	});

	it('uses the singular for a single turn', () => {
		expect(formatCostSummary({ costUsd: 0, turns: 1, durationMs: 5000, results: 1 })).toBe(
			'1 turn · 5s'
		);
	});
});
