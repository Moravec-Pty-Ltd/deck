import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the store/config at a throwaway data dir before importing, so listProjects
// reads our fixture projects.json (see store.test.ts for the same pattern).
const prevDeckData = process.env.DECK_DATA;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-confine-data-'));
process.env.DECK_DATA = dataDir;

// realpath the fixtures: macOS tmpdir is a symlink, and confine canonicalizes.
const mkrealdir = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
// Mock $HOME to a dedicated dir independent of os.tmpdir(), so the picker tests
// hold regardless of where the temp dir lives (it may sit under the user profile).
const fakeHome = mkrealdir('deck-confine-home-');
vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

const projRoot = mkrealdir('deck-confine-proj-');
const outside = mkrealdir('deck-confine-out-');
const worktrees = `${projRoot}-worktrees`;
fs.mkdirSync(path.join(projRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(worktrees, 'feature'), { recursive: true });
const linkOut = path.join(projRoot, 'link-out');
fs.symlinkSync(outside, linkOut);

// A second project whose `<repo>-worktrees` is a symlink pointing outside. Its
// confinement must not extend to the symlink target.
const proj2Root = mkrealdir('deck-confine-proj2-');
const outside2 = mkrealdir('deck-confine-out2-');
fs.mkdirSync(path.join(outside2, 'secret'), { recursive: true });
fs.symlinkSync(outside2, `${proj2Root}-worktrees`);

fs.writeFileSync(
	path.join(dataDir, 'projects.json'),
	JSON.stringify([
		{ name: 'p', path: projRoot },
		{ name: 'p2', path: proj2Root }
	])
);

const { isWithinProjects, isPickerAllowed } = await import('./confine');
const { completeDirs } = await import('./fsutil');

afterAll(() => {
	vi.restoreAllMocks();
	if (prevDeckData === undefined) delete process.env.DECK_DATA;
	else process.env.DECK_DATA = prevDeckData;
	for (const d of [dataDir, projRoot, outside, worktrees, proj2Root, outside2, fakeHome])
		fs.rmSync(d, { recursive: true, force: true });
});

describe('isWithinProjects', () => {
	it('accepts a registered project and its descendants', () => {
		expect(isWithinProjects(projRoot)).toBe(true);
		expect(isWithinProjects(path.join(projRoot, 'src'))).toBe(true);
	});

	it("accepts the project's worktrees dir", () => {
		expect(isWithinProjects(worktrees)).toBe(true);
		expect(isWithinProjects(path.join(worktrees, 'feature'))).toBe(true);
	});

	it('rejects unregistered and non-existent paths', () => {
		expect(isWithinProjects(outside)).toBe(false);
		expect(isWithinProjects('/etc')).toBe(false);
		expect(isWithinProjects(path.join(projRoot, 'does-not-exist'))).toBe(false);
	});

	it('rejects a symlink that escapes the project root', () => {
		// linkOut lives inside the project but resolves to `outside`.
		expect(isWithinProjects(linkOut)).toBe(false);
	});

	it('does not let a symlinked worktrees root extend confinement', () => {
		expect(isWithinProjects(proj2Root)).toBe(true);
		expect(isWithinProjects(path.join(outside2, 'secret'))).toBe(false);
	});
});

describe('isPickerAllowed', () => {
	it('allows $HOME and registered projects', () => {
		fs.mkdirSync(path.join(fakeHome, 'sub'), { recursive: true });
		expect(isPickerAllowed(fakeHome)).toBe(true);
		expect(isPickerAllowed(path.join(fakeHome, 'sub'))).toBe(true);
		expect(isPickerAllowed(projRoot)).toBe(true);
	});

	it('rejects paths outside $HOME and the project set', () => {
		expect(isPickerAllowed(outside)).toBe(false);
		expect(isPickerAllowed('/etc')).toBe(false);
	});
});

describe('completeDirs confinement', () => {
	it('lists children of an allowed (registered) directory', () => {
		const results = completeDirs(`${projRoot}/`);
		expect(results).toContain(path.join(projRoot, 'src'));
	});

	it('returns nothing for a directory outside the allowed roots', () => {
		expect(completeDirs('/etc/')).toEqual([]);
		expect(completeDirs(`${outside}/`)).toEqual([]);
	});
});
