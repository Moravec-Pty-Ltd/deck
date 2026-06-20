import { describe, it, expect, vi } from 'vitest';
import { getOrFetch, invalidateIssues, type IssuesResult } from './cache';

function result(): IssuesResult {
	return { issues: [], errors: [], fetchedAt: Date.now() };
}

// Each test uses a distinct project path so the module-level cache map doesn't
// leak state between cases.
describe('issues cache single-flight', () => {
	it('shares one fan-out across concurrent cache misses', async () => {
		const compute = vi.fn(async () => result());
		const [a, b] = await Promise.all([
			getOrFetch('/p1', false, compute),
			getOrFetch('/p1', false, compute)
		]);
		expect(a).toBe(b);
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it('serves the resolved result on a repeat call within the TTL', async () => {
		const compute = vi.fn(async () => result());
		await getOrFetch('/p2', false, compute);
		await getOrFetch('/p2', false, compute);
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it('refetches a settled entry when refresh is set', async () => {
		const compute = vi.fn(async () => result());
		await getOrFetch('/p3', false, compute);
		await getOrFetch('/p3', true, compute);
		expect(compute).toHaveBeenCalledTimes(2);
	});

	it('joins an in-flight fetch even when refresh is set', async () => {
		const compute = vi.fn(async () => result());
		const [a, b] = await Promise.all([
			getOrFetch('/p4', false, compute),
			getOrFetch('/p4', true, compute)
		]);
		expect(a).toBe(b);
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it('recomputes after invalidateIssues drops the entry', async () => {
		const compute = vi.fn(async () => result());
		await getOrFetch('/p5', false, compute);
		invalidateIssues('/p5');
		await getOrFetch('/p5', false, compute);
		expect(compute).toHaveBeenCalledTimes(2);
	});

	it('recomputes once the TTL window has elapsed', async () => {
		vi.useFakeTimers();
		try {
			const compute = vi.fn(async () => result());
			await getOrFetch('/p6', false, compute);
			vi.advanceTimersByTime(60_001);
			await getOrFetch('/p6', false, compute);
			expect(compute).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not serve a result whose entry was invalidated mid-flight', async () => {
		let release!: (r: IssuesResult) => void;
		const inFlight = new Promise<IssuesResult>((res) => {
			release = res;
		});
		const compute = vi.fn(() => inFlight);
		const pending = getOrFetch('/p8', false, compute);
		invalidateIssues('/p8'); // evict while the fan-out is still in flight
		release(result());
		await pending;
		// The resolved-but-orphaned slot must not be written back; the next call refetches.
		const next = vi.fn(async () => result());
		await getOrFetch('/p8', false, next);
		expect(compute).toHaveBeenCalledTimes(1);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it('evicts a failed fetch so the next call retries', async () => {
		const compute = vi.fn(async (): Promise<IssuesResult> => result());
		compute.mockRejectedValueOnce(new Error('boom'));
		await expect(getOrFetch('/p7', false, compute)).rejects.toThrow('boom');
		await expect(getOrFetch('/p7', false, compute)).resolves.toBeDefined();
		expect(compute).toHaveBeenCalledTimes(2);
	});
});
