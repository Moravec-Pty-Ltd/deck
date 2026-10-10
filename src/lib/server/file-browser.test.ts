import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeckSession } from '$lib/types';

// Point the store at a throwaway data dir before importing, so listProjects
// reads our fixture projects.json (the same pattern as confine.test.ts).
const prevDeckData = process.env.DECK_DATA;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-files-data-'));
process.env.DECK_DATA = dataDir;

const mkrealdir = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const proj = mkrealdir('deck-files-proj-');
const outside = mkrealdir('deck-files-out-');
fs.mkdirSync(path.join(proj, 'src', 'lib'), { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# hi\n');
fs.writeFileSync(path.join(proj, 'src', 'lib', 'a.ts'), 'export {};\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'no\n');
fs.symlinkSync(outside, path.join(proj, 'link-out'));
fs.symlinkSync(path.join(proj, 'missing'), path.join(proj, 'dangling'));
fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{ name: 'p', path: proj }]));

const { listSessionDir } = await import('./file-browser');

const session = (cwd: string) => ({ id: 'c_test', kind: 'claude', title: 't', cwd }) as unknown as DeckSession;

afterAll(() => {
	if (prevDeckData === undefined) delete process.env.DECK_DATA;
	else process.env.DECK_DATA = prevDeckData;
	for (const d of [dataDir, proj, outside]) fs.rmSync(d, { recursive: true, force: true });
});

describe('listSessionDir', () => {
	it("lists the session's folder, folders first, without dangling links", () => {
		const r = listSessionDir(session(proj), '');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.listing.root).toBe(proj);
		expect(r.listing.entries.map((e) => e.name)).toEqual(['link-out', 'src', 'README.md']);
		expect(r.listing.entries.find((e) => e.name === 'README.md')?.size).toBe(5);
	});

	it('lists a nested folder by its relative path', () => {
		const r = listSessionDir(session(proj), 'src/lib/');
		expect(r.ok && r.listing.path).toBe('src/lib');
		expect(r.ok && r.listing.entries.map((e) => e.name)).toEqual(['a.ts']);
	});

	it('starts at a subfolder session and refuses to climb above it', () => {
		expect(listSessionDir(session(path.join(proj, 'src')), '..').ok).toBe(false);
		expect(listSessionDir(session(path.join(proj, 'src')), 'lib').ok).toBe(true);
	});

	it('will not enter a symlink that leaves the projects', () => {
		const r = listSessionDir(session(proj), 'link-out');
		expect(r).toMatchObject({ ok: false, status: 404 });
	});

	it('has nothing to browse for a session outside the projects', () => {
		expect(listSessionDir(session(outside), '')).toMatchObject({ ok: false, status: 403 });
	});

	it('treats a file or a missing path as not found', () => {
		expect(listSessionDir(session(proj), 'README.md')).toMatchObject({ ok: false, status: 404 });
		expect(listSessionDir(session(proj), 'nope')).toMatchObject({ ok: false, status: 404 });
	});
});
