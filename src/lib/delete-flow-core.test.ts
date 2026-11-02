import { describe, it, expect } from 'vitest';
import type { SessionView } from '$lib/session-view';
import { batchErrorMessage, deleteLabel, deleteSequentially, runningSessions, runningWarning } from './delete-flow-core';

function session(id: string): SessionView {
	return { url: '', awaitingInput: false, id, kind: 'claude', title: id, cwd: '/x', createdAt: 0, lastActiveAt: 0, status: 'idle' };
}

const batch = ['a', 'b', 'c'].map((id) => session(id));

describe('deleteSequentially', () => {
	it('deletes one at a time, in order', async () => {
		const inFlight: string[] = [];
		const order: string[] = [];
		await deleteSequentially(
			batch,
			async (s) => {
				inFlight.push(s.id);
				expect(inFlight).toEqual([s.id]);
				await Promise.resolve();
				inFlight.pop();
				order.push(s.id);
			},
			() => {}
		);
		expect(order).toEqual(['a', 'b', 'c']);
	});

	it('collects failures and keeps going', async () => {
		const attempted: string[] = [];
		const failed = await deleteSequentially(
			batch,
			async (s) => {
				attempted.push(s.id);
				if (s.id !== 'c') throw new Error('boom');
			},
			() => {}
		);
		expect(attempted).toEqual(['a', 'b', 'c']);
		expect(failed.map((s) => s.id)).toEqual(['a', 'b']);
	});

	it('returns nothing when every delete lands', async () => {
		expect(await deleteSequentially(batch, async () => {}, () => {})).toEqual([]);
	});

	it('reports every session as settled, failures included', async () => {
		const settled: [string, number][] = [];
		await deleteSequentially(
			batch,
			async (s) => {
				if (s.id === 'b') throw new Error('boom');
			},
			(s, done) => settled.push([s.id, done])
		);
		expect(settled).toEqual([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
	});

	it('does nothing for an empty batch', async () => {
		let calls = 0;
		expect(await deleteSequentially([], async () => void calls++, () => calls++)).toEqual([]);
		expect(calls).toBe(0);
	});
});

describe('batchErrorMessage', () => {
	it('is null when nothing failed', () => {
		expect(batchErrorMessage([], 3)).toBeNull();
	});

	it('names the session when one failed', () => {
		expect(batchErrorMessage([session('only')], 3)).toBe(`Couldn't remove "only".`);
	});

	it('counts them against the batch when several failed', () => {
		expect(batchErrorMessage(batch, 12)).toBe(`Couldn't remove 3 of 12 sessions.`);
	});
});

describe('running warning', () => {
	const at = (id: string, status: SessionView['status'], awaitingInput = false): SessionView => ({
		...session(id),
		status,
		awaitingInput
	});

	it('counts only sessions mid-turn, not ones waiting on a question', () => {
		const list = [at('a', 'running'), at('b', 'idle'), at('c', 'running', true)];
		expect(runningSessions(list).map((s) => s.id)).toEqual(['a']);
	});

	it('leaves an idle confirm unchanged', () => {
		expect(runningWarning([at('a', 'idle')])).toBeNull();
		expect(runningWarning([at('a', 'running', true)])).toBeNull();
		expect(deleteLabel([at('a', 'idle')], 'Remove')).toBe('Remove');
	});

	it('warns for one running session', () => {
		const one = [at('a', 'running')];
		expect(runningWarning(one)).toBe(
			'This session is still working. Deleting it stops the current turn and any subagents, and the work in progress is lost.'
		);
		expect(deleteLabel(one, 'Remove')).toBe('Stop and Delete');
	});

	it('names how many and which in a batch', () => {
		const list = [at('a', 'running'), at('b', 'idle'), at('c', 'running')];
		expect(runningWarning(list)).toBe('2 of these sessions are still working: a, c.');
		expect(runningWarning([at('a', 'running'), at('b', 'idle')])).toBe(
			'1 of these sessions is still working: a.'
		);
		expect(deleteLabel(list, 'Remove')).toBe('Stop and Delete 3 Sessions');
	});
});
