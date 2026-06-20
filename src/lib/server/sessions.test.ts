import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TmuxSession } from './tmux';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sessions-test-'));
process.env.DECK_DATA = dataDir;

// One shared spy for the tmux listing so each test can assert how many times the
// (expensive) subprocess query actually ran. Hoisted so the mock factory below
// can close over it.
const listTmux = vi.hoisted(() => vi.fn(async (): Promise<TmuxSession[]> => []));

vi.mock('./tmux', () => ({
	listTmuxSessions: listTmux,
	createTmuxSession: vi.fn(async () => {}),
	killTmuxSession: vi.fn(async () => {}),
	hasTmuxSession: vi.fn(async () => false)
}));
// Stub the agent dispatch so importing sessions doesn't pull in the live engine.
vi.mock('./agents/dispatch', () => ({
	agentTurnRunning: vi.fn(() => false),
	agentStop: vi.fn()
}));

const sessions = await import('./sessions');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

beforeEach(async () => {
	// createSession busts the list memo, so each test starts from a cold cache.
	await sessions.createSession({ kind: 'shell', cwd: dataDir });
	listTmux.mockClear();
});

describe('listSessions memoization', () => {
	it('shares one tmux query across concurrent callers', async () => {
		const [a, b] = await Promise.all([sessions.listSessions(), sessions.listSessions()]);
		expect(a).toEqual(b);
		expect(listTmux).toHaveBeenCalledTimes(1);
	});

	it('serves a cached result on a repeat call within the window', async () => {
		await sessions.listSessions();
		await sessions.listSessions();
		expect(listTmux).toHaveBeenCalledTimes(1);
	});

	it('recomputes after a session is created', async () => {
		await sessions.listSessions();
		expect(listTmux).toHaveBeenCalledTimes(1);
		await sessions.createSession({ kind: 'shell', cwd: dataDir });
		await sessions.listSessions();
		expect(listTmux).toHaveBeenCalledTimes(2);
	});

	it('recomputes once the TTL window has elapsed', async () => {
		vi.useFakeTimers();
		try {
			await sessions.listSessions();
			expect(listTmux).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1001);
			await sessions.listSessions();
			expect(listTmux).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('evicts a failed computation so the next call retries', async () => {
		listTmux.mockRejectedValueOnce(new Error('boom'));
		await expect(sessions.listSessions()).rejects.toThrow('boom');
		// The rejected promise must not stay pinned for the TTL window.
		await expect(sessions.listSessions()).resolves.toBeInstanceOf(Array);
		expect(listTmux).toHaveBeenCalledTimes(2);
	});
});
