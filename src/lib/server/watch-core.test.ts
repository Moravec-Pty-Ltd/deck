import { describe, expect, it } from 'vitest';
import type { Watch } from '$lib/watches';
import {
	ACTIVE_CAP,
	HISTORY_MS,
	MAX_DELAY_MS,
	OUTPUT_CAP,
	WatchError,
	activeFor,
	bringForward,
	capReached,
	isDue,
	parseDelay,
	parseWatchRequest,
	prune,
	tail,
	wakeMessage
} from './watch-core';

const NOW = 1_700_000_000_000;

function watch(over: Partial<Watch> = {}): Watch {
	return {
		id: 'wat_1',
		sessionId: 'c_1',
		title: 'CI on #42',
		prompt: 'Merge if green.',
		createdAt: NOW,
		dueAt: NOW + 60_000,
		state: 'active',
		...over
	};
}

describe('parseDelay', () => {
	it.each([
		['30s', 30_000],
		['10m', 600_000],
		['2h', 7_200_000],
		['1h30m', 5_400_000],
		['1h 30m 5s', 5_405_000],
		[' 10M ', 600_000]
	])('%s', (text, ms) => expect(parseDelay(text)).toBe(ms));

	it.each(['', '10', 'ten minutes', '10m1h', '1d', '-5m', '1.5h'])('rejects %j', (text) =>
		expect(parseDelay(text)).toBeNull()
	);
});

describe('parseWatchRequest', () => {
	const base = { title: ' CI on #42 ', prompt: ' Merge if green. ' };

	it('trims title and prompt and resolves `in`', () => {
		expect(parseWatchRequest({ ...base, in: '10m' }, NOW)).toEqual({
			title: 'CI on #42',
			prompt: 'Merge if green.',
			command: undefined,
			dueAt: NOW + 600_000
		});
	});

	it('takes `at` as ISO or epoch ms, number or string', () => {
		const at = NOW + 3_600_000;
		expect(parseWatchRequest({ ...base, at }, NOW).dueAt).toBe(at);
		expect(parseWatchRequest({ ...base, at: String(at) }, NOW).dueAt).toBe(at);
		expect(parseWatchRequest({ ...base, at: new Date(at).toISOString() }, NOW).dueAt).toBe(at);
	});

	it('trims the command and drops a blank one', () => {
		expect(parseWatchRequest({ ...base, in: '1m', command: '  gh pr checks 42 ' }, NOW).command).toBe('gh pr checks 42');
		expect(parseWatchRequest({ ...base, in: '1m', command: '  ' }, NOW).command).toBeUndefined();
	});

	it.each([
		[{ ...base }, /exactly one/],
		[{ ...base, in: '1m', at: NOW + 1000 }, /exactly one/],
		[{ ...base, title: '  ', in: '1m' }, /title/],
		[{ ...base, prompt: '', in: '1m' }, /prompt/],
		[{ ...base, in: 'soon' }, /in:/],
		[{ ...base, at: 'tomorrowish' }, /at:/],
		[{ ...base, at: NOW - 1 }, /future/],
		[{ ...base, in: '0s' }, /future/],
		[{ ...base, in: '25h' }, /24 hours/],
		[{ ...base, at: NOW + MAX_DELAY_MS + 1 }, /24 hours/],
		[{ ...base, in: '1m', command: 'x'.repeat(1001) }, /command/],
		[null, /./]
	])('rejects %j', (raw, message) => {
		expect(() => parseWatchRequest(raw, NOW)).toThrow(WatchError);
		expect(() => parseWatchRequest(raw, NOW)).toThrow(message);
	});

	it('allows exactly 24 hours', () => {
		expect(parseWatchRequest({ ...base, in: '24h' }, NOW).dueAt).toBe(NOW + MAX_DELAY_MS);
	});
});

describe('activeFor and capReached', () => {
	it("lists one session's active watches, newest first", () => {
		const list = [
			watch({ id: 'a', createdAt: 1 }),
			watch({ id: 'b', createdAt: 3 }),
			watch({ id: 'c', createdAt: 2, state: 'fired' }),
			watch({ id: 'd', createdAt: 4, sessionId: 'c_2' })
		];
		expect(activeFor(list, 'c_1').map((w) => w.id)).toEqual(['b', 'a']);
	});

	it('caps active watches per session', () => {
		const list = Array.from({ length: ACTIVE_CAP - 1 }, (_, i) => watch({ id: `w${i}` }));
		expect(capReached(list, 'c_1')).toBe(false);
		expect(capReached([...list, watch({ id: 'x', state: 'cancelled' })], 'c_1')).toBe(false);
		expect(capReached([...list, watch({ id: 'x' })], 'c_1')).toBe(true);
		expect(capReached([...list, watch({ id: 'x' })], 'c_2')).toBe(false);
	});
});

describe('isDue', () => {
	it('is due once its time has come, and only while active', () => {
		expect(isDue(watch({ dueAt: NOW + 1 }), NOW)).toBe(false);
		expect(isDue(watch({ dueAt: NOW }), NOW)).toBe(true);
		expect(isDue(watch({ dueAt: NOW - 86_400_000 }), NOW)).toBe(true);
		expect(isDue(watch({ dueAt: NOW, state: 'fired' }), NOW)).toBe(false);
		expect(isDue(watch({ dueAt: NOW, state: 'cancelled' }), NOW)).toBe(false);
	});
});

describe('bringForward', () => {
	it('makes an active watch due now and leaves the rest as they are', () => {
		const w = watch();
		expect(bringForward(w, NOW)).toEqual({ ...w, dueAt: NOW });
		expect(isDue(bringForward(w, NOW), NOW)).toBe(true);
		const overdue = watch({ dueAt: NOW - 5 });
		expect(bringForward(overdue, NOW)).toBe(overdue);
		const fired = watch({ state: 'fired', endedAt: NOW });
		expect(bringForward(fired, NOW)).toBe(fired);
	});
});

describe('prune', () => {
	it('keeps active watches and a day of history', () => {
		const list = [
			watch({ id: 'active', dueAt: 0 }),
			watch({ id: 'recent', state: 'fired', endedAt: NOW - HISTORY_MS + 1 }),
			watch({ id: 'old', state: 'cancelled', endedAt: NOW - HISTORY_MS }),
			watch({ id: 'unstamped', state: 'fired' })
		];
		expect(prune(list, NOW).map((w) => w.id)).toEqual(['active', 'recent']);
	});
});

describe('tail', () => {
	it('keeps the last OUTPUT_CAP characters', () => {
		expect(tail('short')).toBe('short');
		const long = 'a'.repeat(OUTPUT_CAP) + 'END';
		expect(tail(long)).toHaveLength(OUTPUT_CAP);
		expect(tail(long).endsWith('END')).toBe(true);
	});
});

describe('wakeMessage', () => {
	it('is the title and prompt without a command', () => {
		expect(wakeMessage(watch())).toBe('## Watch: CI on #42\n\nMerge if green.');
	});

	it('adds the exit code and the output in a fence', () => {
		const msg = wakeMessage(watch({ command: 'gh pr checks 42', result: { exitCode: 1, output: 'build fail\n' } }));
		expect(msg).toBe('## Watch: CI on #42\n\nMerge if green.\n\nCheck: `gh pr checks 42` exited 1\n\n```\nbuild fail\n```');
	});

	it('leaves the fence out for empty output', () => {
		const msg = wakeMessage(watch({ command: 'true', result: { exitCode: 0, output: '' } }));
		expect(msg.endsWith('Check: `true` exited 0')).toBe(true);
	});

	it('notes a timeout', () => {
		const msg = wakeMessage(watch({ command: 'sleep 99', result: { exitCode: null, output: '', timedOut: true } }));
		expect(msg).toContain('Check: `sleep 99` timed out after 60s');
	});

	it('notes a check that did not run', () => {
		const msg = wakeMessage(watch({ command: 'ls', result: { exitCode: null, output: 'not run: outside' } }));
		expect(msg).toContain('Check: `ls` did not run');
		expect(msg).toContain('not run: outside');
	});

	it('uses a fence longer than any backticks in the output', () => {
		const msg = wakeMessage(watch({ command: 'cat x', result: { exitCode: 0, output: 'a ```` b' } }));
		expect(msg).toContain('`````\na ```` b\n`````');
	});
});
