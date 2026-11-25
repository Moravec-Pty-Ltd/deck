import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';
import { pinEnv } from './test-env';

const [data, fork, plain, other] = ['data', 'fork', 'plain', 'other'].map((n) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `deck-capture-${n}-`))));
const restoreEnv = pinEnv({ DECK_DATA: data });
const git = (...args: string[]) => execFileSync('git', ['-C', fork, ...args], { stdio: 'ignore' });
git('init', '-q');
git('remote', 'add', 'origin', 'git@github.com:me/Web.git');
git('remote', 'add', 'upstream', 'https://github.com/acme/web');
fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify([
	{ name: 'fork', path: fork, sources: [{ id: 's', type: 'github', owner: 'acme', repo: 'api' }] },
	{ name: 'plain', path: plain }
]));
vi.mock('./agent-feed', () => ({ publishAgentEvent: vi.fn() }));
const { capturePr, prToCapture } = await import('./pr-capture');

afterAll(() => {
	restoreEnv();
	for (const d of [data, fork, plain, other]) fs.rmSync(d, { recursive: true, force: true });
});

const session = (over: Partial<DeckSession> = {}) => ({ id: 'c_1', kind: 'claude', cwd: fork, ...over }) as DeckSession;
const link = (repo: string, n = 1) => `https://github.com/${repo}/pull/${n}`;
const captured = async (text: string, s = session()) => (await prToCapture(s, text))?.url ?? null;

it("takes the last link in the session's remotes or its project's sources", async () => {
	expect(await captured(`${link('acme/web', 1)} ${link('ACME/Web', 2)} ${link('else/where', 3)}`)).toBe(link('ACME/Web', 2));
	expect(await captured(link('me/web'))).toBe(link('me/web'));
	expect(await captured(link('acme/api'))).toBe(link('acme/api'));
	expect(await captured(link('else/where'))).toBeNull();
	expect(await captured('no link')).toBeNull();
});

it('takes any link where no repo is known', async () => {
	expect(await captured(link('else/where'), session({ cwd: plain }))).toBe(link('else/where'));
});

it('keeps the PR a session was started on', async () => {
	expect(await captured(link('acme/web'), session({ prSeeded: true }))).toBeNull();
	const old = { pr: { number: 7 } as DeckSession['pr'], worktree: { repo: fork, branch: 'pr/7', createdBranch: true } };
	expect(await captured(link('acme/web'), session(old))).toBeNull();
});

it('reads the checkouts inside a plain folder', async () => {
	execFileSync('git', ['init', '-q', path.join(other, 'a')]);
	execFileSync('git', ['-C', path.join(other, 'a'), 'remote', 'add', 'origin', 'https://github.com/acme/inner']);
	const at = session({ cwd: other });
	expect(await captured(link('acme/inner'), at)).toBe(link('acme/inner'));
	expect(await captured(link('else/where'), at)).toBeNull();
});

it('captures nothing when git fails, and only from sources for a remote session', async () => {
	await expect(prToCapture(session({ cwd: path.join(other, 'gone') }), link('acme/web'))).rejects.toThrow();
	const remote = session({ remote: { target: 'host', path: '/srv' } });
	expect(await captured(link('acme/api'), remote)).toBe(link('acme/api'));
	expect(await captured(link('me/web'), remote)).toBeNull();
});

it('binds in order, and a backfill leaves a newer capture alone', async () => {
	const { saveSession, getStoredSession, updateSession } = await import('./store');
	saveSession(session({ title: 't', status: 'idle', createdAt: 1, lastActiveAt: 1 }));
	void capturePr('c_1', link('acme/web', 1));
	await capturePr('c_1', link('acme/web', 2));
	expect(getStoredSession('c_1')?.pr?.number).toBe(2);
	await capturePr('c_1', link('acme/web', 1), true);
	expect(getStoredSession('c_1')?.pr?.number).toBe(2);
	updateSession('c_1', { pr: undefined });
	await capturePr('c_1', link('acme/web', 3), true);
	expect(getStoredSession('c_1')?.pr?.number).toBe(3);
});
