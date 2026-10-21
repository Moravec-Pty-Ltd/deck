import { describe, it, expect } from 'vitest';
import type { Project } from '$lib/types';
import {
	groupByScope,
	moveWithinScope,
	quickMessagesFor,
	sessionProjectId,
	setScope
} from './quick-messages-core';

const m = (id: string, projectId?: string) => (projectId ? { id, projectId } : { id });
const ids = (list: { id: string }[]) => list.map((x) => x.id);

const projects: Project[] = [
	{ name: 'acme', path: '/p/acme' },
	{ name: 'web', path: '/p/web' }
];

describe('quickMessagesFor', () => {
	const list = [m('g1'), m('a1', '/p/acme'), m('w1', '/p/web'), m('g2'), m('a2', '/p/acme')];

	it('puts the project messages first, then the global ones, in stored order', () => {
		expect(ids(quickMessagesFor(list, '/p/acme'))).toEqual(['a1', 'a2', 'g1', 'g2']);
	});

	it('offers only the global ones without a project', () => {
		expect(ids(quickMessagesFor(list))).toEqual(['g1', 'g2']);
		expect(ids(quickMessagesFor(list, null))).toEqual(['g1', 'g2']);
		expect(ids(quickMessagesFor(list, '/p/other'))).toEqual(['g1', 'g2']);
	});
});

describe('sessionProjectId', () => {
	it('matches the project directory and anything under it', () => {
		expect(sessionProjectId({ cwd: '/p/acme' }, projects)).toBe('/p/acme');
		expect(sessionProjectId({ cwd: '/p/acme/sub' }, projects)).toBe('/p/acme');
	});

	it('folds a worktree back to its repo', () => {
		expect(sessionProjectId({ cwd: '/p/acme-worktrees/feature' }, projects)).toBe('/p/acme');
		expect(
			sessionProjectId(
				{ cwd: '/somewhere/else', worktree: { repo: '/p/web', branch: 'b', createdBranch: true } },
				projects
			)
		).toBe('/p/web');
	});

	it('is undefined outside every registered project', () => {
		expect(sessionProjectId({ cwd: '/p/acme-other' }, projects)).toBeUndefined();
		expect(sessionProjectId({ cwd: '/tmp' }, projects)).toBeUndefined();
	});
});

describe('groupByScope', () => {
	it('lists Global first, then projects in registered order, then unregistered scopes', () => {
		const list = [m('w1', '/p/web'), m('x1', '/p/gone'), m('a1', '/p/acme'), m('g1')];
		const groups = groupByScope(list, projects);
		expect(groups.map((g) => [g.label, g.projectId, g.items.map((i) => i.index)])).toEqual([
			['Global', undefined, [3]],
			['acme', '/p/acme', [2]],
			['web', '/p/web', [0]],
			['/p/gone', '/p/gone', [1]]
		]);
	});

	it('always has a Global section, even when empty', () => {
		expect(groupByScope([], projects)).toEqual([{ label: 'Global', items: [] }]);
	});
});

describe('moveWithinScope', () => {
	const list = [m('g1'), m('a1', '/p/acme'), m('g2'), m('a2', '/p/acme')];

	it('swaps with the neighbour in the same scope, skipping others', () => {
		expect(ids(moveWithinScope(list, 2, -1))).toEqual(['g2', 'a1', 'g1', 'a2']);
		expect(ids(moveWithinScope(list, 1, 1))).toEqual(['g1', 'a2', 'g2', 'a1']);
	});

	it('leaves the list alone at either end of the scope', () => {
		expect(moveWithinScope(list, 0, -1)).toBe(list);
		expect(moveWithinScope(list, 3, 1)).toBe(list);
	});
});

describe('setScope', () => {
	it('moves a message to the end of its new scope', () => {
		const list = [m('g1'), m('g2'), m('a1', '/p/acme')];
		const next = setScope(list, 0, '/p/acme');
		expect(ids(next)).toEqual(['g2', 'a1', 'g1']);
		expect(next[2].projectId).toBe('/p/acme');
	});

	it('makes a message global with an empty or missing scope', () => {
		expect(setScope([m('a1', '/p/acme')], 0, '')[0].projectId).toBeUndefined();
		expect(setScope([m('a1', '/p/acme')], 0)[0].projectId).toBeUndefined();
	});
});
