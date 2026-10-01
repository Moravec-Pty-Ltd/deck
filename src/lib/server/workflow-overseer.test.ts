import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';
import type { WorkflowRun } from '$lib/workflows';

// The overseer is optional by design: notes queue while it is mid-turn, flush
// when it finishes, and vanish harmlessly when it is gone.
const fake = vi.hoisted(() => ({
	overseerId: undefined as string | undefined,
	sessions: new Map<string, DeckSession>(),
	busy: false,
	sent: [] as { id: string; text: string }[],
	interrupted: [] as string[]
}));

vi.mock('./agent-feed', async () => {
	const { EventEmitter } = await import('node:events');
	return { agentFeed: new EventEmitter() };
});
vi.mock('./config', () => ({ baseUrl: 'http://localhost:4818', dataDir: '/tmp/deck-overseer-test' }));
vi.mock('./store', () => ({ getStoredSession: (id: string) => fake.sessions.get(id) }));
vi.mock('./agents/dispatch', () => ({
	agentSend: async (s: DeckSession, text: string) => void fake.sent.push({ id: s.id, text }),
	agentTurnRunning: () => fake.busy,
	agentInterrupt: (id: string) => void fake.interrupted.push(id)
}));
vi.mock('./create-session', () => ({ createSessionFromRequest: async () => ({ id: 'o2' }) }));
vi.mock('./agent-digest', () => ({ sessionDigest: (s: DeckSession) => ({ id: s.id }) }));
vi.mock('./transcript', () => ({ sessionLastResult: () => 'last words' }));
vi.mock('./workflow-store', () => ({
	overseerId: () => fake.overseerId,
	setOverseerId: (id: string | undefined) => void (fake.overseerId = id)
}));

const { agentFeed } = await import('./agent-feed');
const { noteOverseer, overseerStatus, startOverseer, stopOverseer } = await import('./workflow-overseer');
const { BUILTIN_WORKFLOWS, newRun } = await import('./workflow-core');

const session = (id: string) => ({ id, kind: 'claude', title: id, cwd: '/', createdAt: 0, lastActiveAt: 0, status: 'idle' }) as DeckSession;
const run = (): WorkflowRun =>
	newRun({ id: 'r_1', def: BUILTIN_WORKFLOWS[0], projectPath: '/p', cwd: '/p-worktrees/x', branch: 'x', title: '#1', profile: { loop: false }, now: 0 });

beforeEach(() => {
	stopOverseer();
	fake.sessions.clear();
	fake.busy = false;
	fake.sent = [];
});

describe('the overseer', () => {
	it('is a no-op with no overseer, so runs never depend on it', () => {
		noteOverseer(run(), 'blocked');
		expect(fake.sent).toEqual([]);
		expect(overseerStatus()).toEqual({ sessionId: undefined, active: false, busy: false });
	});

	it('queues notes while it is mid-turn and flushes them when its turn ends', () => {
		fake.overseerId = 'o1';
		fake.sessions.set('o1', session('o1'));
		fake.busy = true;
		noteOverseer(run(), 'blocked');
		noteOverseer(run(), 'done');
		expect(fake.sent).toEqual([]);
		expect(overseerStatus()).toMatchObject({ active: true, busy: true });
		fake.busy = false;
		agentFeed.emit('event', { type: 'turn-finished', sessionId: 'o1' });
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0].text).toContain('blocked at implement');
		expect(fake.sent[0].text).toContain('done at implement');
	});

	it('does not register a start that a stop overtook', async () => {
		fake.overseerId = undefined;
		const first = startOverseer();
		stopOverseer();
		await expect(first).rejects.toThrow('stopped');
		expect(overseerStatus().active).toBe(false);
		expect(fake.interrupted).toEqual(['o2']);
	});

	it('treats a deleted overseer session as gone, and start makes a new one', async () => {
		fake.overseerId = 'o1';
		noteOverseer(run(), 'blocked');
		expect(fake.sent).toEqual([]);
		expect(await startOverseer()).toBe('o2');
	});
});
