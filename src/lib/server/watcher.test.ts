import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeckSession, Project } from '$lib/types';
import { pinEnv } from './test-env';

// Firing is orchestration: a watch must be marked fired before its check
// awaits, wait out a running turn, survive a check that hangs, and go when its
// session does. Drive pollWatches over the real store in a throwaway data dir,
// with a faked session layer and agent.
const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-watcher-')));
const projectDir = path.join(tmpDir, 'example');
fs.mkdirSync(projectDir);
const restoreEnv = pinEnv({ DECK_DATA: tmpDir });

const fake = vi.hoisted(() => ({
	sessions: [] as DeckSession[],
	projects: [] as Project[],
	sent: [] as { id: string; text: string }[],
	running: new Set<string>()
}));

vi.mock('./watch-core', async (orig) => ({ ...(await orig<typeof import('./watch-core')>()), CHECK_TIMEOUT_MS: 300 }));
vi.mock('./agent-feed', () => ({ publishAgentEvent: () => {} }));
vi.mock('./agents/dispatch', () => ({ agentTurnRunning: (id: string) => fake.running.has(id) }));
vi.mock('./send-agent-message', () => ({
	sendAgentMessage: async ({ id }: DeckSession, { text }: { text: string }) => void fake.sent.push({ id, text })
}));
vi.mock('./sessions', () => ({ getSession: async (sid: string) => fake.sessions.find(({ id }) => id === sid) }));
vi.mock('./store', () => ({
	listProjects: () => fake.projects,
	getStoredSession: (sid: string) => fake.sessions.find(({ id }) => id === sid)
}));

const { pollWatches, runWatchNow } = await import('./watcher');
const store = await import('./watch-store');
const { createWatch, getWatch, listWatches, saveWatch } = store;

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function session(over: Partial<DeckSession> = {}): DeckSession {
	return { id: 'c_live', kind: 'claude', title: 'work', cwd: projectDir, createdAt: 0, lastActiveAt: 0, status: 'idle', permissionMode: 'bypassPermissions', ...over };
}

// A watch already due, created through the store so it has a real id.
function due(over: { command?: string; sessionId?: string } = {}) {
	const w = createWatch(over.sessionId ?? 'c_live', { title: 'CI', prompt: 'Merge if green.', in: '1m', command: over.command });
	saveWatch({ ...w, dueAt: Date.now() - 1000 });
	return w.id;
}

beforeEach(() => {
	(globalThis as { __deckWatches?: unknown }).__deckWatches = { watches: [] };
	fake.sessions = [session()];
	fake.projects = [{ name: 'example', path: projectDir }];
	fake.sent = [];
	fake.running = new Set();
});

describe('pollWatches', () => {
	it('fires a due watch once, with its check result', async () => {
		const id = due({ command: 'echo hi; exit 3' });
		await pollWatches();
		await pollWatches();
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0].text).toContain('Check: `echo hi; exit 3` exited 3');
		expect(fake.sent[0].text).toContain('hi');
		expect(getWatch(id)).toMatchObject({ state: 'fired', result: { exitCode: 3, output: 'hi\n' } });
	});

	it('keeps a watch active and cancellable while its check runs', async () => {
		const id = due({ command: 'sleep 0.2' });
		const poll = pollWatches();
		await vi.waitFor(() => expect(getWatch(id)?.state).toBe('active'));
		store.cancelWatch(id);
		await poll;
		expect(fake.sent).toHaveLength(0);
		expect(getWatch(id)?.state).toBe('cancelled');
	});

	it('checks again after a turn that started during the check', async () => {
		const id = due({ command: 'echo run >> runs.txt; sleep 0.2' });
		const poll = pollWatches();
		await vi.waitFor(() => expect(fs.existsSync(path.join(projectDir, 'runs.txt'))).toBe(true));
		fake.running.add('c_live');
		await poll;
		expect(fake.sent).toHaveLength(0);
		expect(getWatch(id)?.state).toBe('active');
		fake.running.clear();
		await pollWatches();
		expect(fake.sent).toHaveLength(1);
		expect(fs.readFileSync(path.join(projectDir, 'runs.txt'), 'utf8')).toBe('run\nrun\n');
	});

	it('wakes the agent when a check cannot start', async () => {
		const id = due({ command: 'echo \u0000' });
		await pollWatches();
		expect(getWatch(id)).toMatchObject({ state: 'fired', result: { exitCode: null } });
		expect(getWatch(id)?.result?.output).toMatch(/not run/);
		expect(fake.sent).toHaveLength(1);
	});

	it('refuses a check command unless the session skips permission prompts', () => {
		fake.sessions = [session({ permissionMode: 'default' })];
		expect(() => createWatch('c_live', { title: 'CI', prompt: 'p', in: '1m', command: 'ls' })).toThrow(/permission/);
		expect(createWatch('c_live', { title: 'Later', prompt: 'p', in: '1m' }).state).toBe('active');
	});

	it('does not run a check once the session stops skipping permission prompts', async () => {
		const id = due({ command: 'touch ran.txt' });
		fake.sessions = [session({ permissionMode: 'plan' })];
		await pollWatches();
		expect(fs.existsSync(path.join(projectDir, 'ran.txt'))).toBe(false);
		expect(getWatch(id)?.result?.output).toMatch(/not run/);
		expect(fake.sent).toHaveLength(1);
	});

	it('kills what a check leaves running in the background', async () => {
		due({ command: 'sleep 5 & echo $! > bg.pid; exit 0' });
		await pollWatches();
		const pid = Number(fs.readFileSync(path.join(projectDir, 'bg.pid'), 'utf8'));
		await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
		expect(fake.sent[0].text).toContain('exited 0');
	});

	it('leaves a watch that is not due yet', async () => {
		createWatch('c_live', { title: 'later', prompt: 'p', in: '10m' });
		await pollWatches();
		expect(fake.sent).toHaveLength(0);
	});

	it('waits while a turn is running, then fires', async () => {
		const id = due();
		fake.running.add('c_live');
		await pollWatches();
		expect(fake.sent).toHaveLength(0);
		expect(getWatch(id)?.state).toBe('active');
		fake.running.clear();
		await pollWatches();
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0].text).toBe('## Watch: CI\n\nMerge if green.');
	});

	it('wakes a session once per pass when two watches are due', async () => {
		due();
		due();
		await pollWatches();
		expect(fake.sent).toHaveLength(1);
		expect(listWatches().filter((w) => w.state === 'active')).toHaveLength(1);
	});

	it('kills a check past the limit and fires with a timeout note', async () => {
		const id = due({ command: 'echo started; sleep 30' });
		const started = Date.now();
		await pollWatches();
		expect(Date.now() - started).toBeLessThan(5000);
		expect(getWatch(id)?.result).toMatchObject({ exitCode: null, timedOut: true, output: 'started\n' });
		expect(fake.sent[0].text).toContain('timed out');
	});

	it('does not run a check outside the registered projects', async () => {
		fake.projects = [];
		const id = due({ command: 'echo hi' });
		await pollWatches();
		expect(getWatch(id)?.result).toMatchObject({ exitCode: null });
		expect(fake.sent[0].text).toContain('did not run');
	});

	it("cancels a gone session's watches without waking anything", async () => {
		const id = due({ sessionId: 'c_gone' });
		await pollWatches();
		expect(fake.sent).toHaveLength(0);
		expect(getWatch(id)?.state).toBe('cancelled');
	});
});

describe('runWatchNow', () => {
	const later = (command?: string): string => createWatch('c_live', { title: 'CI', prompt: 'Merge if green.', in: '1h', command }).id;

	it('runs the check and wakes the session as the timer would', async () => {
		const id = later('echo green');
		expect(runWatchNow(id)?.dueAt).toBeLessThanOrEqual(Date.now());
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		expect(fake.sent[0].text).toBe('## Watch: CI\n\nMerge if green.\n\nCheck: `echo green` exited 0\n\n```\ngreen\n```');
		expect(getWatch(id)?.state).toBe('fired');
	});

	it('fires a watch without a check straight away', async () => {
		runWatchNow(later());
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		expect(fake.sent[0].text).toBe('## Watch: CI\n\nMerge if green.');
	});

	it('waits for a running turn, then wakes the session once', async () => {
		fake.running.add('c_live');
		const first = later();
		const second = later();
		runWatchNow(first);
		runWatchNow(second);
		await pollWatches();
		expect(fake.sent).toHaveLength(0);
		expect(getWatch(first)?.state).toBe('active');
		fake.running.clear();
		await pollWatches();
		expect(fake.sent).toHaveLength(1);
		expect(store.activeWatches('c_live')).toHaveLength(1);
	});

	it('goes again after a pass that was busy when it was asked', async () => {
		fake.sessions.push(session({ id: 'c_other' }));
		const slow = due({ command: 'sleep 0.2', sessionId: 'c_other' });
		const busy = pollWatches();
		const id = later();
		runWatchNow(id);
		await busy;
		expect(getWatch(slow)?.state).toBe('fired');
		expect(getWatch(id)?.state).toBe('fired');
	});

	it('leaves an ended watch alone and knows nothing of an unknown one', async () => {
		const id = later();
		const cancelled = store.cancelWatch(id);
		expect(runWatchNow(id)).toEqual(cancelled);
		await pollWatches();
		expect(fake.sent).toHaveLength(0);
		expect(runWatchNow('wat_nope')).toBeUndefined();
	});
});

describe('watch store', () => {
	it('caps active watches per session', () => {
		for (let i = 0; i < 5; i++) createWatch('c_live', { title: 't', prompt: 'p', in: '1m' });
		expect(() => createWatch('c_live', { title: 't', prompt: 'p', in: '1m' })).toThrow(/5 active/);
	});

	it('cancels a session’s active watches and keeps them as history', () => {
		const a = createWatch('c_live', { title: 't', prompt: 'p', in: '1m' });
		store.cancelSessionWatches('c_live');
		expect(store.activeWatches('c_live')).toEqual([]);
		expect(listWatches('c_live')).toMatchObject([{ id: a.id, state: 'cancelled' }]);
		expect(store.cancelWatch('wat_nope')).toBeUndefined();
	});
});
