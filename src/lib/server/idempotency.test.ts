import { describe, it, expect, vi } from 'vitest';
import { runIdempotent } from './idempotency';

describe('runIdempotent', () => {
	it('runs fn unconditionally without a key', async () => {
		const fn = vi.fn(async () => 'a');
		const { replay, result } = runIdempotent(null, fn);
		expect(replay).toBe(false);
		expect(await result).toBe('a');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('replays a cached result for the same key within the window', async () => {
		const fn = vi.fn(async () => ({ id: 'c_1' }));
		const first = runIdempotent('k-window', fn, 1000);
		await first.result;
		const second = runIdempotent('k-window', fn, 2000);
		expect(second.replay).toBe(true);
		expect(await second.result).toEqual({ id: 'c_1' });
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('re-runs once the key has expired', async () => {
		const fn = vi.fn(async () => 'x');
		runIdempotent('k-expire', fn, 0);
		await Promise.resolve();
		const again = runIdempotent('k-expire', fn, 11 * 60 * 1000);
		expect(again.replay).toBe(false);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('evicts a failed attempt so a retry runs again', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce('ok');
		const first = runIdempotent('k-fail', fn, 0);
		await expect(first.result).rejects.toThrow('boom');
		const second = runIdempotent('k-fail', fn, 1);
		expect(second.replay).toBe(false);
		expect(await second.result).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
