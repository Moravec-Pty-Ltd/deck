import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeLimit, silenceLimitMs, startSilenceWatchdog } from './watchdog-core';

describe('silenceLimitMs', () => {
	it('defaults to half an hour, past any plausible single tool call', () => {
		expect(silenceLimitMs({})).toBe(1800000);
	});

	it('honours a positive override', () => {
		expect(silenceLimitMs({ DECK_TURN_SILENCE_MS: '5000' })).toBe(5000);
	});

	it('ignores junk and non-positive overrides', () => {
		expect(silenceLimitMs({ DECK_TURN_SILENCE_MS: 'soon' })).toBe(1800000);
		expect(silenceLimitMs({ DECK_TURN_SILENCE_MS: '0' })).toBe(1800000);
		expect(silenceLimitMs({ DECK_TURN_SILENCE_MS: '-1' })).toBe(1800000);
	});
});

describe('describeLimit', () => {
	it('reads in whole minutes once minutes round honestly', () => {
		expect(describeLimit(1800000)).toBe('30m');
		expect(describeLimit(120000)).toBe('2m');
	});

	it('falls back to seconds for a tuned-down limit, which would round to 0m or 2m', () => {
		expect(describeLimit(45000)).toBe('45s');
		expect(describeLimit(90000)).toBe('90s');
		expect(describeLimit(5000)).toBe('5s');
	});
});

describe('startSilenceWatchdog', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('trips once the child has been quiet for the whole limit', () => {
		const onSilent = vi.fn();
		startSilenceWatchdog(1000, onSilent);
		vi.advanceTimersByTime(999);
		expect(onSilent).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onSilent).toHaveBeenCalledOnce();
	});

	it('does not cut off a slow but healthy turn', () => {
		const onSilent = vi.fn();
		const watchdog = startSilenceWatchdog(1000, onSilent);
		for (let i = 0; i < 20; i++) {
			vi.advanceTimersByTime(900);
			watchdog.bump();
		}
		expect(onSilent).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(onSilent).toHaveBeenCalledOnce();
	});

	it('reports a stall exactly once, even if output arrives afterwards', () => {
		const onSilent = vi.fn();
		const watchdog = startSilenceWatchdog(1000, onSilent);
		vi.advanceTimersByTime(1000);
		watchdog.bump();
		vi.advanceTimersByTime(10000);
		expect(onSilent).toHaveBeenCalledOnce();
	});

	it('stops watching once the turn ends, and stays stopped', () => {
		const onSilent = vi.fn();
		const watchdog = startSilenceWatchdog(1000, onSilent);
		watchdog.stop();
		watchdog.bump();
		vi.advanceTimersByTime(10000);
		expect(onSilent).not.toHaveBeenCalled();
	});
});
