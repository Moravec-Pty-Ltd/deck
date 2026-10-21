import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pinEnv } from './test-env';

// The route only accepts network clone urls, so git rewrites this one to a local
// bare repo (url.<base>.insteadOf, set through the environment cloneRepo passes
// on). Nothing here touches the network.
const URL_BASE = 'https://git.example.invalid/acme/';
const mkreal = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const dataDir = mkreal('deck-clone-data-');
const home = mkreal('deck-clone-home-');
const outside = mkreal('deck-clone-out-');
const remotes = mkreal('deck-clone-remotes-');

const gitEnv = {
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@example.com',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@example.com'
};
const seed = path.join(remotes, 'seed');
execFileSync('git', ['init', '-q', seed]);
execFileSync('git', ['-C', seed, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: { ...process.env, ...gitEnv } });
execFileSync('git', ['clone', '-q', '--bare', seed, path.join(remotes, 'widget.git')]);

const restoreEnv = pinEnv({
	DECK_DATA: dataDir,
	GIT_CONFIG_COUNT: '1',
	GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`,
	GIT_CONFIG_VALUE_0: URL_BASE
});
vi.spyOn(os, 'homedir').mockReturnValue(home);

const { cloneProjectRoute } = await import('./project-clone');
const { listProjects } = await import('./store');

afterAll(() => {
	restoreEnv();
	vi.restoreAllMocks();
	for (const dir of [dataDir, home, outside, remotes]) fs.rmSync(dir, { recursive: true, force: true });
});

const clone = (body: unknown) =>
	cloneProjectRoute({ request: new Request('http://deck.test/api', { method: 'POST', body: JSON.stringify(body) }) });

async function status(run: () => unknown): Promise<number> {
	try {
		await run();
	} catch (e) {
		return (e as { status: number }).status;
	}
	throw new Error('expected a rejection');
}

describe('cloneProjectRoute', () => {
	it('clones into <parent>/<repo> and registers it', async () => {
		const res = await clone({ url: `${URL_BASE}widget.git`, parent: '~', group: 'apps' });
		const dest = path.join(home, 'widget');
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ name: 'widget', path: dest, group: 'apps' });
		expect(fs.existsSync(path.join(dest, '.git'))).toBe(true);
		expect(listProjects().map((p) => p.path)).toEqual([dest]);
	});

	it('409s a destination that already exists', async () => {
		expect(await status(() => clone({ url: `${URL_BASE}widget.git`, parent: home }))).toBe(409);
	});

	it('403s a parent outside $HOME and the registered projects', async () => {
		expect(await status(() => clone({ url: `${URL_BASE}widget.git`, parent: outside }))).toBe(403);
		expect(fs.readdirSync(outside)).toEqual([]);
	});

	it('403s a destination in a dot-directory under $HOME, cloning nothing', async () => {
		fs.mkdirSync(path.join(home, '.config'));
		fs.symlinkSync(path.join(home, '.config'), path.join(home, 'config-link'));
		for (const parent of ['~/.config', '~/config-link']) {
			expect(await status(() => clone({ url: `${URL_BASE}widget.git`, parent }))).toBe(403);
		}
		expect(await status(() => clone({ url: `${URL_BASE}.widget.git`, parent: '~' }))).toBe(403);
		expect(fs.readdirSync(path.join(home, '.config'))).toEqual([]);
		expect(listProjects()).toHaveLength(1);
	});

	it('stores the real path when the parent is a symlink', async () => {
		fs.mkdirSync(path.join(home, 'code'));
		fs.symlinkSync(path.join(home, 'code'), path.join(home, 'code-link'));
		const res = await clone({ url: `${URL_BASE}widget.git`, parent: '~/code-link' });
		expect((await res.json()).path).toBe(path.join(home, 'code', 'widget'));
		expect(listProjects().map((p) => p.path)).toContain(path.join(home, 'code', 'widget'));
	});

	it('400s a local-path url and a failed clone, registering nothing', async () => {
		expect(await status(() => clone({ url: path.join(remotes, 'widget.git'), parent: home }))).toBe(400);
		expect(await status(() => clone({ url: `${URL_BASE}missing.git`, parent: home }))).toBe(400);
		expect(listProjects()).toHaveLength(2);
	});
});
