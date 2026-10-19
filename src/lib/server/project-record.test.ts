import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pinEnv } from './test-env';

const mkreal = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const dataDir = mkreal('deck-project-record-data-');
const home = mkreal('deck-project-record-home-');
const outside = mkreal('deck-project-record-out-');
const restoreEnv = pinEnv({ DECK_DATA: dataDir });
vi.spyOn(os, 'homedir').mockReturnValue(home);

const { registerProjectRoute, removeProjectRoute, projectConfigRoute, patchProjectConfigRoute, completeDirsRoute } =
	await import('./project-record');
const { listProjects } = await import('./store');

afterAll(() => {
	restoreEnv();
	vi.restoreAllMocks();
	for (const dir of [dataDir, home, outside]) fs.rmSync(dir, { recursive: true, force: true });
});

const app = path.join(home, 'app');
fs.mkdirSync(path.join(app, 'src'), { recursive: true });
fs.mkdirSync(path.join(home, 'apple'));

const send = (method: string, body: unknown) =>
	new Request('http://deck.test/api', { method, body: JSON.stringify(body) });
const at = (query: string) => new URL(`http://deck.test/api?${query}`);

// The status of a handler that rejected through SvelteKit's error().
async function status(run: () => unknown): Promise<number> {
	try {
		await run();
	} catch (e) {
		return (e as { status: number }).status;
	}
	throw new Error('expected a rejection');
}

describe('registerProjectRoute', () => {
	it('registers a directory under $HOME, expanding ~', async () => {
		const res = await registerProjectRoute({ request: send('POST', { path: '~/app/', group: 'apps' }) });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ name: 'app', path: app, group: 'apps' });
		expect(listProjects().map((p) => p.path)).toEqual([app]);
	});

	it('refuses a directory outside $HOME and the registered projects', async () => {
		expect(await status(() => registerProjectRoute({ request: send('POST', { path: outside }) }))).toBe(403);
		expect(listProjects().some((p) => p.path === outside)).toBe(false);
	});

	it('accepts a directory inside a registered project', async () => {
		const res = await registerProjectRoute({ request: send('POST', { path: path.join(app, 'src') }) });
		expect(res.status).toBe(201);
		removeProjectRoute({ url: at(`path=${encodeURIComponent(path.join(app, 'src'))}`) });
	});

	it('400s a missing directory and a malformed body', async () => {
		expect(await status(() => registerProjectRoute({ request: send('POST', { path: path.join(home, 'nope') }) }))).toBe(400);
		expect(await status(() => registerProjectRoute({ request: send('POST', [1]) }))).toBe(400);
		expect(await status(() => registerProjectRoute({ request: send('POST', { path: app, group: 1 }) }))).toBe(400);
	});

	it('keeps the stored name when a re-save omits it', async () => {
		await patchProjectConfigRoute({ request: send('PATCH', { path: app, name: 'App' }) });
		const res = await registerProjectRoute({ request: send('POST', { path: app, template: 'go' }) });
		expect(await res.json()).toMatchObject({ name: 'App', group: 'apps', template: 'go' });
	});
});

describe('project config', () => {
	it('reads one record, or every record without a path', async () => {
		expect(await projectConfigRoute({ url: at(`path=${encodeURIComponent(app)}`) }).json()).toMatchObject({ path: app });
		expect(await projectConfigRoute({ url: at('') }).json()).toEqual(listProjects());
		expect(await status(() => projectConfigRoute({ url: at('path=/path/to/nowhere') }))).toBe(404);
	});

	it('patches only the fields sent', async () => {
		const res = await patchProjectConfigRoute({ request: send('PATCH', { path: app, reviewPrompt: 'Review', group: '' }) });
		expect(await res.json()).toEqual({ name: 'App', path: app, template: 'go', reviewPrompt: 'Review' });
		expect(listProjects()).toEqual([{ name: 'App', path: app, template: 'go', reviewPrompt: 'Review' }]);
	});

	it('404s an unregistered path and 400s a missing or malformed one', async () => {
		expect(await status(() => patchProjectConfigRoute({ request: send('PATCH', { path: outside }) }))).toBe(404);
		expect(await status(() => patchProjectConfigRoute({ request: send('PATCH', {}) }))).toBe(400);
		expect(await status(() => patchProjectConfigRoute({ request: send('PATCH', { path: app, dev: 'x' }) }))).toBe(400);
	});
});

describe('completeDirsRoute', () => {
	it('completes under $HOME and returns nothing outside it', async () => {
		expect(await completeDirsRoute({ url: at('q=~/ap') }).json()).toEqual(['~/app', '~/apple']);
		expect(await completeDirsRoute({ url: at(`q=${encodeURIComponent(outside + '/')}`) }).json()).toEqual([]);
	});
});

describe('removeProjectRoute', () => {
	it('unregisters a project and requires a path', async () => {
		expect(await removeProjectRoute({ url: at(`path=${encodeURIComponent(app)}`) }).json()).toEqual({ ok: true });
		expect(listProjects()).toEqual([]);
		expect(await status(() => removeProjectRoute({ url: at('') }))).toBe(400);
	});
});
