import { describe, it, expect } from 'vitest';
import type { DeckSession, Project } from '$lib/types';
import {
	groupSessions,
	groupProjects,
	existingGroupNames,
	compareGroupNames,
	UNGROUPED
} from './groups';

function project(name: string, path: string, group?: string): Project {
	return { name, path, group };
}

function session(id: string, cwd: string, lastActiveAt: number): DeckSession {
	return {
		id,
		kind: 'shell',
		title: id,
		cwd,
		createdAt: 0,
		lastActiveAt,
		status: 'idle'
	};
}

describe('compareGroupNames', () => {
	it('orders alphanumerically with Ungrouped last', () => {
		const names = ['Work', UNGROUPED, 'Apex', 'beta'];
		expect([...names].sort(compareGroupNames)).toEqual(['Apex', 'beta', 'Work', UNGROUPED]);
	});
});

describe('groupProjects', () => {
	const projects = [
		project('zeta', '/p/zeta', 'Work'),
		project('alpha', '/p/alpha', 'Work'),
		project('solo', '/p/solo', 'Personal'),
		project('loose', '/p/loose'),
		project('blankish', '/p/blankish', '   ')
	];

	it('clusters by group, alphanumeric with Ungrouped last', () => {
		const groups = groupProjects(projects);
		expect(groups.map((g) => g.name)).toEqual(['Personal', 'Work', UNGROUPED]);
	});

	it('orders projects within a group alphanumerically by name', () => {
		const work = groupProjects(projects).find((g) => g.name === 'Work')!;
		expect(work.projects.map((p) => p.name)).toEqual(['alpha', 'zeta']);
	});

	it('treats blank/whitespace groups as Ungrouped', () => {
		const ungrouped = groupProjects(projects).find((g) => g.name === UNGROUPED)!;
		expect(ungrouped.projects.map((p) => p.name).sort()).toEqual(['blankish', 'loose']);
	});
});

describe('existingGroupNames', () => {
	it('returns distinct, sorted, non-blank group names', () => {
		const projects = [
			project('a', '/a', 'Work'),
			project('b', '/b', 'Work'),
			project('c', '/c', 'Apex'),
			project('d', '/d'),
			project('e', '/e', '  ')
		];
		expect(existingGroupNames(projects)).toEqual(['Apex', 'Work']);
	});
});

describe('groupSessions', () => {
	const projects = [
		project('alpha', '/repos/alpha', 'Work'),
		project('beta', '/repos/beta', 'Work'),
		project('solo', '/repos/solo', 'Personal'),
		project('loose', '/repos/loose') // registered but ungrouped
	];

	it('builds two levels: group -> project subgroup -> sessions', () => {
		const sessions = [
			session('a1', '/repos/alpha', 10),
			session('a2', '/repos/alpha/sub', 20),
			session('b1', '/repos/beta', 5)
		];
		const groups = groupSessions(sessions, projects);
		const work = groups.find((g) => g.name === 'Work')!;
		expect(work.subgroups.map((s) => s.label).sort()).toEqual(['alpha', 'beta']);
		const alpha = work.subgroups.find((s) => s.label === 'alpha')!;
		expect(alpha.sessions.map((s) => s.id).sort()).toEqual(['a1', 'a2']);
		expect(work.sessionCount).toBe(3);
	});

	it('folds worktrees back under their repo subgroup', () => {
		const sessions = [
			session('main', '/repos/alpha', 10),
			session('wt', '/repos/alpha-worktrees/feature', 20)
		];
		const work = groupSessions(sessions, projects);
		const alpha = work[0].subgroups.find((s) => s.label === 'alpha')!;
		expect(alpha.sessions.map((s) => s.id).sort()).toEqual(['main', 'wt']);
	});

	it('orders groups alphanumerically with Ungrouped last', () => {
		const sessions = [
			session('w', '/repos/alpha', 1),
			session('p', '/repos/solo', 2),
			session('u', '/repos/loose', 3),
			session('adhoc', '/tmp/elsewhere', 4)
		];
		const groups = groupSessions(sessions, projects);
		expect(groups.map((g) => g.name)).toEqual(['Personal', 'Work', UNGROUPED]);
	});

	it('orders subgroups within a group by most-recent activity', () => {
		const sessions = [
			session('a', '/repos/alpha', 10),
			session('b', '/repos/beta', 99) // beta more recent
		];
		const work = groupSessions(sessions, projects)[0];
		expect(work.subgroups.map((s) => s.label)).toEqual(['beta', 'alpha']);
	});

	it('collects adhoc and ungrouped-project sessions under Ungrouped', () => {
		const sessions = [
			session('adhoc', '/tmp/scratch', 1), // not a registered project
			session('loose', '/repos/loose', 2) // registered but no group
		];
		const groups = groupSessions(sessions, projects);
		const ungrouped = groups.find((g) => g.name === UNGROUPED)!;
		expect(ungrouped.sessionCount).toBe(2);
		expect(ungrouped.subgroups.map((s) => s.label).sort()).toEqual(
			['loose', shortLabel('/tmp/scratch')].sort()
		);
	});
});

// The adhoc subgroup label is the shortPath of the cwd; recompute it the same way
// deriveGroup does so the assertion isn't environment-coupled.
function shortLabel(p: string): string {
	return p
		.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, '~')
		.replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}
