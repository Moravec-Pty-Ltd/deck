import { describe, it, expect } from 'vitest';
import type { DeckSession, Project } from '$lib/types';
import { hiddenProjectPaths, stampHidden, visibleSessions, withHidden } from './hidden-core';

function project(name: string, path: string, hidden?: boolean): Project {
	return { name, path, hidden };
}

function session(id: string, cwd: string): DeckSession {
	return { id, kind: 'shell', title: id, cwd, createdAt: 0, lastActiveAt: 0, status: 'idle' };
}

describe('hiddenProjectPaths', () => {
	it('collects only the hidden ones', () => {
		const paths = hiddenProjectPaths([
			project('a', '/p/a', true),
			project('b', '/p/b'),
			project('c', '/p/c', false)
		]);
		expect([...paths]).toEqual(['/p/a']);
	});
});

describe('stampHidden', () => {
	const projects = [project('acme', '/p/acme', true), project('web', '/p/web')];

	it('hides a session by its own id', () => {
		const sessions = [session('s1', '/p/web'), session('s2', '/p/web')];
		const out = stampHidden(sessions, new Set(['s2']), projects);
		expect(out.map((s) => !!s.hidden)).toEqual([false, true]);
	});

	it('hides every session in a hidden project', () => {
		const out = stampHidden([session('s1', '/p/acme/sub')], new Set(), projects);
		expect(out[0].hidden).toBe(true);
	});

	it('hides a worktree session with the project it branched from', () => {
		const out = stampHidden(
			[session('s1', '/p/acme-worktrees/feature')],
			new Set(),
			projects
		);
		expect(out[0].hidden).toBe(true);
	});

	it('leaves the list untouched when nothing is hidden', () => {
		const sessions = [session('s1', '/p/web')];
		expect(stampHidden(sessions, new Set(), [project('web', '/p/web')])).toBe(sessions);
	});

	it('does not hide an unrelated directory that shares a prefix', () => {
		const out = stampHidden([session('s1', '/p/acme-other')], new Set(), projects);
		expect(out[0].hidden).toBeUndefined();
	});
});

describe('withHidden', () => {
	it('adds, sorts and de-duplicates', () => {
		expect(withHidden(['c', 'a'], 'b', true)).toEqual(['a', 'b', 'c']);
		expect(withHidden(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
	});

	it('drops an id, and drops nothing when it is absent', () => {
		expect(withHidden(['a', 'b'], 'a', false)).toEqual(['b']);
		expect(withHidden(['a'], 'z', false)).toEqual(['a']);
	});
});

describe('visibleSessions', () => {
	it('keeps what is not hidden', () => {
		const shown = session('s1', '/p/web');
		const gone = { ...session('s2', '/p/web'), hidden: true };
		expect(visibleSessions([shown, gone])).toEqual([shown]);
	});
});
