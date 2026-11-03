import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { pinEnv } from './test-env';

// A start in a new folder must register the project before the session exists,
// so the session is created inside it; a refusal must leave nothing behind.
const mkreal = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const dataDir = mkreal('deck-create-session-data-');
const home = mkreal('deck-create-session-home-');
const restoreEnv = pinEnv({ DECK_DATA: dataDir });
vi.spyOn(os, 'homedir').mockReturnValue(home);

const seen = vi.hoisted(() => ({ projectsAtCreate: [] as string[][] }));
vi.mock('./sessions', () => ({
	createSession: async (opts: { cwd: string }) => {
		const { listProjects } = await import('./store');
		seen.projectsAtCreate.push(listProjects().map((p) => p.path));
		return { id: 'example', cwd: opts.cwd };
	}
}));
vi.mock('./accounts', () => ({ accountProblem: async () => null }));
vi.mock('./agents/dispatch', () => ({ agentSend: vi.fn() }));

const { createSessionFromRequest } = await import('./create-session');
const { listProjects } = await import('./store');

afterAll(() => {
	restoreEnv();
	vi.restoreAllMocks();
	for (const dir of [dataDir, home]) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => (seen.projectsAtCreate = []));

const start = (body: Record<string, unknown>) => createSessionFromRequest({ kind: 'shell', ...body }, { remember: false });

it('creates the folder and registers it before the session starts there', async () => {
	const dir = path.join(home, 'code', 'fresh');
	const session = await start({ cwd: '~/code/fresh', createDir: true, registerProject: { group: 'new' } });
	expect(session.cwd).toBe(dir);
	expect(fs.statSync(dir).isDirectory()).toBe(true);
	expect(seen.projectsAtCreate).toEqual([[dir]]);
	expect(listProjects()).toEqual([{ name: 'fresh', path: dir, group: 'new' }]);
});

it('starts nothing and creates nothing when registration is refused', async () => {
	await expect(start({ cwd: '~/code/other', createDir: true, registerProject: { name: 1 } })).rejects.toMatchObject({ status: 400 });
	await expect(start({ cwd: '~/.deck/x', createDir: true })).rejects.toMatchObject({ status: 400 });
	await expect(start({ cwd: '~/code/wt', createDir: true, worktree: { branch: 'x', newBranch: true } })).rejects.toMatchObject({ status: 400 });
	await expect(start({ cwd: '~/code/fresh', registerProject: {} })).rejects.toMatchObject({ status: 400 });
	expect(seen.projectsAtCreate).toEqual([]);
	expect(fs.readdirSync(home)).toEqual(['code']);
	expect(fs.readdirSync(path.join(home, 'code'))).toEqual(['fresh']);
});

it('keeps the 400 for a missing folder without createDir', async () => {
	await expect(start({ cwd: '~/code/missing' })).rejects.toMatchObject({ status: 400, body: { message: 'cwd does not exist' } });
	expect(seen.projectsAtCreate).toEqual([]);
});
