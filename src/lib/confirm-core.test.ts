import { describe, expect, it } from 'vitest';
import { ConfirmQueue, type ConfirmOptions } from './confirm-core';

describe('ConfirmQueue', () => {
	it('resolves with the answer and clears the open confirm', async () => {
		const seen: (ConfirmOptions | null)[] = [];
		const q = new ConfirmQueue((c) => seen.push(c));
		const answer = q.ask({ title: 'Delete it?' });
		expect(q.current?.title).toBe('Delete it?');
		q.settle(true);
		await expect(answer).resolves.toBe(true);
		expect(q.current).toBeNull();
		expect(seen.map((c) => c?.title ?? null)).toEqual(['Delete it?', null]);
	});

	it('cancels the open confirm when a new one is asked', async () => {
		const q = new ConfirmQueue();
		const first = q.ask({ title: 'First' });
		const second = q.ask({ title: 'Second' });
		await expect(first).resolves.toBe(false);
		expect(q.current?.title).toBe('Second');
		q.settle(true);
		await expect(second).resolves.toBe(true);
	});

	it('ignores a settle with nothing open', () => {
		const seen: unknown[] = [];
		const q = new ConfirmQueue((c) => seen.push(c));
		q.settle(true);
		expect(seen).toEqual([]);
	});
});
