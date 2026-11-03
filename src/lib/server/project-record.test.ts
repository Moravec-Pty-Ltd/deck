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

const {
	registerProjectRoute,
	removeProjectRoute,
	projectConfigRoute,
	patchProjectConfigRoute,
	completeDirsRoute,
	planStartFolder,
	commitStartFolder,
	folderStateRoute
} = await import('./project-record');
const { addProject, listProjects } = await import('./store');

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

describe('registerProjectRoute refusals and canonical paths', () => {
	const post = (p: string) => registerProjectRoute({ request: send('POST', { path: p }) });

	it('refuses $HOME and any dot-directory under it', async () => {
		fs.mkdirSync(path.join(home, '.secrets'));
		fs.mkdirSync(path.join(home, 'code', '.hidden', 'app'), { recursive: true });
		for (const p of ['~', '~/', '~/.secrets', path.join(home, 'code', '.hidden', 'app')]) {
			expect(await status(() => post(p))).toBe(403);
		}
		expect(listProjects()).toEqual([]);
	});

	it('refuses a symlink that resolves to a dot-directory', async () => {
		fs.symlinkSync(path.join(home, '.secrets'), path.join(home, 'innocent'));
		expect(await status(() => post('~/innocent'))).toBe(403);
		expect(listProjects()).toEqual([]);
	});

	it('stores the canonical path and re-saves it through the link', async () => {
		fs.symlinkSync(app, path.join(home, 'app-link'));
		expect(await (await post('~/app-link')).json()).toMatchObject({ path: app, name: 'app' });
		await registerProjectRoute({ request: send('POST', { path: '~/app-link', group: 'g' }) });
		expect(listProjects()).toEqual([{ name: 'app', path: app, group: 'g' }]);
		removeProjectRoute({ url: at(`path=${encodeURIComponent(app)}`) });
	});

	it('still re-saves a record stored under its old, non-canonical path', async () => {
		const legacy = path.join(home, 'app-link');
		addProject({ name: 'Legacy', path: legacy });
		const res = await registerProjectRoute({ request: send('POST', { path: legacy, template: 't' }) });
		expect(await res.json()).toEqual({ name: 'Legacy', path: legacy, template: 't' });
		expect(listProjects()).toEqual([{ name: 'Legacy', path: legacy, template: 't' }]);
		removeProjectRoute({ url: at(`path=${encodeURIComponent(legacy)}`) });
	});
});

describe('start folder', () => {
	const fresh = path.join(home, 'code', 'fresh', 'deep');

	it('plans a missing folder without touching disk, then creates and registers it', () => {
		const plan = planStartFolder(' ~/code/fresh/deep/ ', true, { name: 'Fresh', group: 'new' });
		expect(plan).toEqual({ cwd: fresh, create: true, project: { name: 'Fresh', path: fresh, group: 'new' } });
		expect(fs.existsSync(path.join(home, 'code', 'fresh'))).toBe(false);
		expect(listProjects()).toEqual([]);
		commitStartFolder(plan);
		expect(fs.statSync(fresh).isDirectory()).toBe(true);
		expect(listProjects()).toEqual([{ name: 'Fresh', path: fresh, group: 'new' }]);
	});

	it('keeps the 400 for a missing folder without createDir, and starts in an existing one as is', async () => {
		expect(await status(() => planStartFolder('~/code/absent', undefined, undefined))).toBe(400);
		expect(planStartFolder('~/apple', true, undefined)).toEqual({ cwd: path.join(home, 'apple'), create: false });
	});

	it('names a registered existing folder after itself and refuses one already registered', async () => {
		expect(planStartFolder('~/apple', undefined, {}).project).toEqual({ name: 'apple', path: path.join(home, 'apple') });
		expect(await status(() => planStartFolder(fresh, undefined, {}))).toBe(400);
		expect(await status(() => planStartFolder('~/apple', undefined, true))).toBe(400);
		expect(await status(() => planStartFolder('~/apple', undefined, { group: 1 }))).toBe(400);
		expect(await status(() => planStartFolder('~', undefined, {}))).toBe(403);
	});

	it.each([
		['~/.deck/x', 'hidden'],
		['~/code/../../x', 'outside'],
		[`${home}/code/../x`, 'hidden'],
		['relative/x', 'absolute'],
		['~/code/a\0b', 'absolute'],
		['~/innocent/x', 'hidden (dot) directory'],
		[path.join(outside, 'x'), 'outside']
	])('refuses to create %s and creates nothing', async (raw, reason) => {
		const before = fs.readdirSync(home).sort();
		try {
			planStartFolder(raw, true, {});
			throw new Error('expected a refusal');
		} catch (e) {
			expect(e).toMatchObject({ status: 400, body: { message: expect.stringContaining(reason) } });
		}
		expect(fs.readdirSync(home).sort()).toEqual(before);
		expect(fs.readdirSync(outside)).toEqual([]);
	});

	it('tells the start sheet whether a typed path exists, is new, or is refused', async () => {
		const state = async (p: string) => folderStateRoute({ url: at(`path=${encodeURIComponent(p)}`) }).json();
		expect(await state('~/code/fresh/deep/sub')).toEqual({ state: 'new', registrable: true, project: fresh });
		expect(await state('~/code/fresh/deep/')).toEqual({ state: 'existing', registrable: true, project: fresh });
		expect(await state('~/apple')).toEqual({ state: 'existing', registrable: true });
		expect(await state('~/code/brand-new')).toEqual({ state: 'new', registrable: true });
		expect(await state('~')).toEqual({ state: 'existing', registrable: false });
		expect(await state('~/.deck/x')).toMatchObject({ state: 'refused', registrable: false });
		// Outside the roots an existing folder, a file and a missing path all look alike.
		fs.mkdirSync(path.join(outside, 'dir'));
		fs.writeFileSync(path.join(outside, 'file'), '');
		for (const p of ['dir', 'file/x', 'missing/x']) {
			expect(await state(path.join(outside, p))).toEqual({ state: 'outside', registrable: false });
		}
		fs.rmSync(path.join(outside, 'dir'), { recursive: true });
		fs.rmSync(path.join(outside, 'file'));
		expect(await status(() => folderStateRoute({ url: at('') }))).toBe(400);
	});
});
