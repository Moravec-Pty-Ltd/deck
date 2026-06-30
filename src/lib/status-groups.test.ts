import { describe, it, expect } from 'vitest';
import type { DeckSession, SessionStatus } from '$lib/types';
import { bucketSessions } from './status-groups';

function session(
	id: string,
	status: SessionStatus,
	lastActiveAt: number,
	awaitingInput = false
): DeckSession {
	return { id, kind: 'claude', title: id, cwd: '/x', createdAt: 0, lastActiveAt, status, awaitingInput };
}

describe('bucketSessions', () => {
	it('orders buckets needs-attention -> active -> idle -> dead', () => {
		const sessions = [
			session('dead', 'dead', 1),
			session('idle', 'idle', 2),
			session('run', 'running', 3),
			session('err', 'error', 4)
		];
		expect(bucketSessions(sessions).map((b) => b.key)).toEqual([
			'needs-attention',
			'active',
			'idle',
			'dead'
		]);
	});

	it('hides empty buckets', () => {
		const buckets = bucketSessions([session('a', 'running', 1), session('b', 'running', 2)]);
		expect(buckets.map((b) => b.key)).toEqual(['active']);
	});

	it('puts errored and awaiting-input sessions in needs-attention', () => {
		const sessions = [
			session('err', 'error', 1),
			session('asking', 'running', 2, true),
			session('idle-asking', 'idle', 3, true)
		];
		const attention = bucketSessions(sessions).find((b) => b.key === 'needs-attention')!;
		expect(attention.sessions.map((s) => s.id).sort()).toEqual(['asking', 'err', 'idle-asking']);
	});

	it('keeps an asking session out of active even while running', () => {
		const buckets = bucketSessions([session('asking', 'running', 1, true)]);
		expect(buckets.map((b) => b.key)).toEqual(['needs-attention']);
	});

	it('sorts within a bucket by most-recent activity', () => {
		const sessions = [session('old', 'idle', 5), session('new', 'idle', 50)];
		const idle = bucketSessions(sessions).find((b) => b.key === 'idle')!;
		expect(idle.sessions.map((s) => s.id)).toEqual(['new', 'old']);
	});

	it('treats a plain idle session as idle, not needs-attention', () => {
		const buckets = bucketSessions([session('i', 'idle', 1)]);
		expect(buckets.map((b) => b.key)).toEqual(['idle']);
	});

	it('handles an idle session with no awaitingInput field (the production default)', () => {
		const s: DeckSession = {
			id: 'i',
			kind: 'claude',
			title: 'i',
			cwd: '/x',
			createdAt: 0,
			lastActiveAt: 1,
			status: 'idle'
		};
		expect(bucketSessions([s]).map((b) => b.key)).toEqual(['idle']);
	});
});
