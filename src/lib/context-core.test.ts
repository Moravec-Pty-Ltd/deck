import { describe, expect, it } from 'vitest';
import {
	COMPACT_PERCENT_MAX,
	COMPACT_PERCENT_MIN,
	DEFAULT_COMPACT_PERCENT,
	clampCompactPercent,
	compactCommand,
	contextPercent,
	emptyContext,
	foldContext,
	formatContext,
	formatTokens,
	overCompactThreshold,
	resultWindow,
	usedTokens
} from './context-core';

// Shapes taken from a real claude stream (see the module comment).
const assistant = (used: Record<string, number>) => ({ type: 'assistant', message: { usage: used } });
const result = (contextWindow: number, model = 'claude-opus-5') => ({
	type: 'result',
	subtype: 'success',
	modelUsage: { [model]: { contextWindow, maxOutputTokens: 64000 } }
});

describe('usedTokens', () => {
	it('adds fresh input, cache writes, cache reads, and output', () => {
		expect(usedTokens({ input_tokens: 2, cache_creation_input_tokens: 864, cache_read_input_tokens: 702516, output_tokens: 8 })).toBe(703390);
	});

	it('ignores absent, negative, and non-numeric parts rather than going NaN', () => {
		expect(usedTokens({ input_tokens: 5 })).toBe(5);
		expect(usedTokens({ input_tokens: -5, output_tokens: 3 })).toBe(3);
		expect(usedTokens({ input_tokens: 'lots' })).toBe(0);
		expect(usedTokens(null)).toBe(0);
		expect(usedTokens('nope')).toBe(0);
	});
});

describe('resultWindow', () => {
	it('reads the window the model reported', () => {
		expect(resultWindow(result(1_000_000))).toBe(1_000_000);
	});

	it('takes the largest when a turn used more than one model', () => {
		expect(
			resultWindow({ modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 }, 'claude-opus-5': { contextWindow: 1_000_000 } } })
		).toBe(1_000_000);
	});

	it('is 0 when nothing reported one', () => {
		expect(resultWindow({ type: 'result' })).toBe(0);
		expect(resultWindow({ modelUsage: { m: {} } })).toBe(0);
		expect(resultWindow(null)).toBe(0);
	});
});

describe('foldContext', () => {
	it('takes the newest assistant usage as a level, not a running sum', () => {
		let state = emptyContext();
		state = foldContext(state, assistant({ cache_read_input_tokens: 100_000 }));
		state = foldContext(state, assistant({ cache_read_input_tokens: 150_000 }));
		expect(state.used).toBe(150_000);
	});

	it('picks the window up from a result and keeps it across later messages', () => {
		let state = emptyContext();
		state = foldContext(state, assistant({ cache_read_input_tokens: 40_000 }));
		state = foldContext(state, result(200_000));
		state = foldContext(state, assistant({ cache_read_input_tokens: 60_000 }));
		expect(state).toEqual({ used: 60_000, window: 200_000 });
	});

	it('follows a compaction down, since the message after it carries the new usage', () => {
		let state = { used: 999_000, window: 1_000_000 };
		state = foldContext(state, { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 1_000_871, post_tokens: 13_070 } });
		expect(state.used).toBe(999_000); // the boundary itself says nothing
		state = foldContext(state, assistant({ cache_read_input_tokens: 13_070 }));
		expect(state).toEqual({ used: 13_070, window: 1_000_000 });
	});

	it('passes through events that carry no figure, and survives junk', () => {
		const state = { used: 10, window: 100 };
		expect(foldContext(state, { type: 'user' })).toBe(state);
		expect(foldContext(state, assistant({}))).toBe(state);
		expect(foldContext(state, { type: 'result' })).toBe(state);
		expect(foldContext(state, null)).toBe(state);
		expect(foldContext(state, 'nope')).toBe(state);
	});
});

describe('contextPercent', () => {
	it('rounds, and caps at 100 when a turn overruns the window', () => {
		expect(contextPercent({ used: 702_516, window: 1_000_000 })).toBe(70);
		expect(contextPercent({ used: 1_003_057, window: 1_000_000 })).toBe(100);
	});

	it('is 0 before any window has been reported', () => {
		expect(contextPercent({ used: 50_000, window: 0 })).toBe(0);
	});
});

describe('formatting', () => {
	it('reads a window in thousands below a million', () => {
		expect(formatTokens(703_390)).toBe('703k');
		expect(formatTokens(1_000_000)).toBe('1.0M');
		expect(formatTokens(1_250_000)).toBe('1.3M');
		expect(formatTokens(812)).toBe('812');
		expect(formatTokens(0)).toBe('0');
	});

	it('spells out the pair, or just the count when no window is known', () => {
		expect(formatContext({ used: 248_000, window: 1_000_000 })).toBe('248k / 1.0M tokens');
		expect(formatContext({ used: 248_000, window: 0 })).toBe('248k tokens');
	});
});

describe('compaction threshold', () => {
	it('holds the percentage inside a range where compacting is worth doing', () => {
		expect(clampCompactPercent(80)).toBe(80);
		expect(clampCompactPercent(10)).toBe(COMPACT_PERCENT_MIN);
		expect(clampCompactPercent(99)).toBe(COMPACT_PERCENT_MAX);
		expect(clampCompactPercent(80.4)).toBe(80);
		expect(clampCompactPercent(undefined)).toBe(DEFAULT_COMPACT_PERCENT);
		expect(clampCompactPercent('80')).toBe(DEFAULT_COMPACT_PERCENT);
		expect(clampCompactPercent(NaN)).toBe(DEFAULT_COMPACT_PERCENT);
	});

	it('fires at or past the threshold, never on a session with no figures yet', () => {
		expect(overCompactThreshold({ used: 800_000, window: 1_000_000 }, 80)).toBe(true);
		expect(overCompactThreshold({ used: 799_999, window: 1_000_000 }, 80)).toBe(false);
		expect(overCompactThreshold({ used: 900_000, window: 0 }, 80)).toBe(false);
		expect(overCompactThreshold({ used: 0, window: 1_000_000 }, 80)).toBe(false);
	});
});

describe('compactCommand', () => {
	it('is a slash command carrying the handoff headings', () => {
		const command = compactCommand();
		expect(command.startsWith('/compact ')).toBe(true);
		for (const heading of ['goal', 'in progress', 'next concrete steps', 'blockers', 'key files', 'decisions', 'git state']) {
			expect(command).toContain(heading);
		}
	});
});
