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

const JUST_FINISHED_MS = 15 * 60 * 1000;
// A fixed "now" well past the epoch so `now - lastActiveAt` windows are easy to reason about.
const NOW = 100 * 60 * 1000;

describe('bucketSessions', () => {
	it('orders buckets needs-attention -> active -> just-finished -> idle -> dead', () => {
		const sessions = [
			session('dead', 'dead', 1),
			session('idle', 'idle', NOW - 30 * 60 * 1000),
			session('just', 'idle', NOW - 5 * 60 * 1000),
			session('run', 'running', NOW),
			session('err', 'error', NOW)
		];
		expect(bucketSessions(sessions, NOW).map((b) => b.key)).toEqual([
			'needs-attention',
			'active',
			'just-finished',
			'idle',
			'dead'
		]);
	});

	it('buckets a recently-idle session as just-finished', () => {
		const buckets = bucketSessions([session('s', 'idle', NOW - 5 * 60 * 1000)], NOW);
		expect(buckets.map((b) => b.key)).toEqual(['just-finished']);
	});

	it('leaves a long-idle session in idle', () => {
		const buckets = bucketSessions([session('s', 'idle', NOW - 20 * 60 * 1000)], NOW);
		expect(buckets.map((b) => b.key)).toEqual(['idle']);
	});

	it('treats exactly the threshold as just-finished and one ms past as idle', () => {
		const onEdge = bucketSessions([session('s', 'idle', NOW - JUST_FINISHED_MS)], NOW);
		expect(onEdge.map((b) => b.key)).toEqual(['just-finished']);
		const past = bucketSessions([session('s', 'idle', NOW - JUST_FINISHED_MS - 1)], NOW);
		expect(past.map((b) => b.key)).toEqual(['idle']);
	});

	it('does not pull recent running/dead/error/asking sessions into just-finished', () => {
		const sessions = [
			session('run', 'running', NOW),
			session('dead', 'dead', NOW),
			session('err', 'error', NOW),
			session('asking', 'idle', NOW, true)
		];
		expect(bucketSessions(sessions, NOW).map((b) => b.key)).toEqual([
			'needs-attention',
			'active',
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
