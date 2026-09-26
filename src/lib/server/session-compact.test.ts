import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';

const sessions: Record<string, DeckSession> = {
	c_work: { id: 'c_work', kind: 'claude', title: 'Work', cwd: '/p', status: 'idle', createdAt: 1, lastActiveAt: 2 } as DeckSession,
	s_term: { id: 's_term', kind: 'shell', title: 'Term', cwd: '/p', status: 'idle', createdAt: 1, lastActiveAt: 2 } as DeckSession,
	x_codex: { id: 'x_codex', kind: 'codex', title: 'Codex', cwd: '/p', status: 'idle', createdAt: 1, lastActiveAt: 2 } as DeckSession
};

let running = new Set<string>();
const compacted = vi.fn(async (_session: DeckSession) => {});

vi.mock('./store', () => ({
	setSessionsMutatedHook: () => {},
	getStoredSession: (id: string) => sessions[id]
}));
vi.mock('./agents/dispatch', () => ({
	agentTurnRunning: (id: string) => running.has(id),
	agentStop: () => {}
}));
vi.mock('./auto-compact', () => ({ compactSession: (s: DeckSession) => compacted(s) }));

const { compactSessionRoute } = await import('./session-compact');

async function status(id: string): Promise<number> {
	try {
		return (await compactSessionRoute({ params: { id } })).status;
	} catch (err) {
		return (err as { status: number }).status;
	}
}

beforeEach(() => {
	running = new Set();
	vi.clearAllMocks();
});

describe('compactSessionRoute', () => {
	it('compacts an idle claude session', async () => {
		expect(await status('c_work')).toBe(200);
		expect(compacted).toHaveBeenCalledWith(sessions.c_work);
	});

	it('refuses a kind that has no /compact command', async () => {
		expect(await status('s_term')).toBe(400);
		expect(await status('x_codex')).toBe(400);
		expect(compacted).not.toHaveBeenCalled();
	});

	// A compaction is a turn of its own, so it would queue behind the running one
	// and land somewhere the user did not ask for.
	it('refuses while a turn is running', async () => {
		running.add('c_work');
		expect(await status('c_work')).toBe(409);
		expect(compacted).not.toHaveBeenCalled();
	});

	it('404s an unknown session', async () => {
		expect(await status('c_gone')).toBe(404);
	});
});
