import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';

let stored: DeckSession[] = [];
let tmuxNames: string[] = [];
const patched = vi.fn();
const renamed = vi.fn();
const published = vi.fn();
const invalidated = vi.fn();

vi.mock('./store', () => ({
	// sessions.ts registers its list memo here at import time (via http.ts).
	setSessionsMutatedHook: () => {},
	getStoredSession: (id: string) => stored.find((s) => s.id === id),
	updateSession: (id: string, patch: Partial<DeckSession>) => {
		patched(id, patch);
		const session = stored.find((s) => s.id === id);
		if (session) Object.assign(session, patch);
		return session;
	}
}));
vi.mock('./tmux', () => ({
	listTmuxSessions: async () => tmuxNames.map((name) => ({ name })),
	renameTmuxSession: async (from: string, to: string) => {
		renamed(from, to);
		tmuxNames = tmuxNames.map((n) => (n === from ? to : n));
	}
}));
vi.mock('./agent-feed', () => ({
	publishAgentEvent: (...args: unknown[]) => published(...args)
}));
vi.mock('./sessions', () => ({ invalidateSessionList: () => invalidated() }));

const { renameSession } = await import('./session-title');

function rename(id: string, body: unknown) {
	return renameSession({ params: { id }, request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }) });
}

async function status(promise: Promise<Response>): Promise<number> {
	try {
		return (await promise).status;
	} catch (err) {
		return (err as { status: number }).status;
	}
}

beforeEach(() => {
	stored = [
		{ id: 'c_auth', kind: 'claude', title: 'Auth token refresh', cwd: '/p', status: 'idle', createdAt: 1, lastActiveAt: 2 } as DeckSession,
		{ id: 's_dev', kind: 'shell', title: 'Voyager', cwd: '/p', status: 'idle', createdAt: 1, lastActiveAt: 2, tmuxName: 'deck-dev' } as DeckSession
	];
	tmuxNames = ['7', 'morabot'];
	vi.clearAllMocks();
});

describe('renameSession, stored sessions', () => {
	it('saves a cleaned title, keeps the id, and announces it', async () => {
		const res = await rename('c_auth', { title: '  Auth  refresh\n round two ' });
		expect(await res.json()).toEqual({ ok: true, id: 'c_auth', title: 'Auth refresh round two' });
		expect(patched).toHaveBeenCalledWith('c_auth', { title: 'Auth refresh round two' });
		expect(published).toHaveBeenCalledWith('c_auth', 'session-renamed', { title: 'Auth refresh round two', id: 'c_auth' });
	});

	it('leaves a managed shell its tmux session, renaming only the label', async () => {
		await rename('s_dev', { title: 'Dev server' });
		expect(patched).toHaveBeenCalledWith('s_dev', { title: 'Dev server' });
		expect(renamed).not.toHaveBeenCalled();
	});

	it('is a no-op when the title has not moved', async () => {
		const res = await rename('c_auth', { title: 'Auth token refresh' });
		expect(res.status).toBe(200);
		expect(patched).not.toHaveBeenCalled();
		expect(published).not.toHaveBeenCalled();
	});

	it('rejects an empty, overlong, or non-string title without touching the store', async () => {
		expect(await status(rename('c_auth', { title: '   ' }))).toBe(400);
		expect(await status(rename('c_auth', { title: 'a'.repeat(81) }))).toBe(400);
		expect(await status(rename('c_auth', { title: 7 }))).toBe(400);
		expect(await status(rename('c_auth', 'not an object'))).toBe(400);
		expect(patched).not.toHaveBeenCalled();
	});

	it('404s an id that is neither stored nor an adhoc terminal', async () => {
		expect(await status(rename('c_gone', { title: 'New' }))).toBe(404);
	});
});

describe('renameSession, adhoc terminals', () => {
	it('renames the tmux session and reports the id it moved to', async () => {
		const res = await rename('t_7', { title: 'hermes logs' });
		expect(renamed).toHaveBeenCalledWith('7', 'hermes logs');
		expect(await res.json()).toEqual({ ok: true, id: 't_hermes logs', title: 'hermes logs' });
		// Published against the handle the caller held, carrying where it went.
		expect(published).toHaveBeenCalledWith('t_7', 'session-renamed', { title: 'hermes logs', id: 't_hermes logs' });
		// No store write happened, so the list memo has to be dropped by hand or
		// the redirect to the new id lands on a list that predates the rename.
		expect(invalidated).toHaveBeenCalled();
	});

	it('strips a colon, which tmux could never target again', async () => {
		const res = await rename('t_7', { title: 'build: web' });
		expect(renamed).toHaveBeenCalledWith('7', 'build- web');
		expect(await res.json()).toEqual({ ok: true, id: 't_build- web', title: 'build- web' });
	});

	it('409s rather than colliding with a terminal that already has the name', async () => {
		expect(await status(rename('t_7', { title: 'morabot' }))).toBe(409);
		expect(renamed).not.toHaveBeenCalled();
	});

	it('refuses a dev-server name, which the session list filters out', async () => {
		expect(await status(rename('t_7', { title: 'deck-srv-web' }))).toBe(400);
		expect(renamed).not.toHaveBeenCalled();
	});

	it('404s a terminal that is no longer running', async () => {
		expect(await status(rename('t_ghost', { title: 'anything' }))).toBe(404);
	});

	it('is a no-op when the name has not moved', async () => {
		const res = await rename('t_7', { title: '7' });
		expect(res.status).toBe(200);
		expect(renamed).not.toHaveBeenCalled();
		expect(published).not.toHaveBeenCalled();
	});
});
