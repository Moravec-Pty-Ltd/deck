import { describe, it, expect } from 'vitest';
import type { Project } from '$lib/types';
import type { SessionView } from '$lib/session-view';
import {
	groupSessions,
	groupProjects,
	hiddenGroup,
	existingGroupNames,
	compareGroupNames,
	groupAfterOpening,
	groupEntries,
	groupOfPath,
	inGroup,
	pickerGroups,
	resolveGroup,
	sessionPath,
	startProject,
	waitingElsewhere,
	HIDDEN,
	OTHER_GROUPS,
	UNGROUPED
} from './groups';

function project(name: string, path: string, group?: string): Project {
	return { name, path, group };
}

function session(id: string, cwd: string, lastActiveAt: number): SessionView {
	return {
		id,
		url: '',
		awaitingInput: false,
		kind: 'shell',
		title: id,
		cwd,
		createdAt: 0,
		lastActiveAt,
		status: 'idle'
	};
}

describe('compareGroupNames', () => {
	it('orders alphanumerically with Ungrouped then Hidden last', () => {
		const names = ['Work', HIDDEN, UNGROUPED, 'Apex', 'beta'];
		expect([...names].sort(compareGroupNames)).toEqual([
			'Apex',
			'beta',
			'Work',
			UNGROUPED,
			HIDDEN
		]);
	});
});

describe('groupSessions', () => {
	it('lists unread sessions first within their project, recency otherwise', () => {
		const sessions = [
			session('new', '/p/web', 9),
			{ ...session('read-later', '/p/web', 5), unread: true },
			session('mid', '/p/web', 4),
			{ ...session('oldest', '/p/web', 1), unread: true }
		];
		const [group] = groupSessions(sessions, [project('web', '/p/web')]);
		expect(group.subgroups[0].sessions.map((s) => s.id)).toEqual(['read-later', 'oldest', 'new', 'mid']);
	});
});

describe('hiddenGroup', () => {
	const projects = [project('acme', '/p/acme', 'Work'), project('web', '/p/web')];

	it('is absent until something is hidden', () => {
		expect(hiddenGroup([session('s1', '/p/web', 1)], projects)).toBeNull();
	});

	it('collects every hidden session under its project, whatever its group', () => {
		const sessions = [
			session('s1', '/p/web', 1),
			{ ...session('s2', '/p/acme', 3), hidden: true },
			{ ...session('s3', '/p/web', 2), hidden: true }
		];
		const group = hiddenGroup(sessions, projects)!;
		expect(group.name).toBe(HIDDEN);
		expect(group.sessionCount).toBe(2);
		// Most recently active project first, as everywhere else.
		expect(group.subgroups.map((g) => g.key)).toEqual(['/p/acme', '/p/web']);
		expect(group.subgroups[0].sessions.map((s) => s.id)).toEqual(['s2']);
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

	it('moves a hidden project out of its group and into Hidden, last', () => {
		const groups = groupProjects([...projects, { ...project('gone', '/p/gone', 'Work'), hidden: true }]);
		expect(groups.map((g) => g.name)).toEqual(['Personal', 'Work', UNGROUPED, HIDDEN]);
		expect(groups.at(-1)!.projects.map((p) => p.name)).toEqual(['gone']);
		expect(groups.find((g) => g.name === 'Work')!.projects.map((p) => p.name)).toEqual([
			'alpha',
			'zeta'
		]);
	});

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

describe('group switcher', () => {
	const projects = [
		project('web', '/p/web', 'Client A'),
		project('api', '/p/api', 'Client A'),
		project('site', '/p/site', 'Client B'),
		project('scratch', '/p/scratch')
	];
	const asking = (id: string, cwd: string) => ({ ...session(id, cwd, 0), awaitingInput: true });
	const unread = (id: string, cwd: string) => ({ ...session(id, cwd, 0), unread: true });

	it('places worktree sessions under their repo, and anything else under Ungrouped', () => {
		expect(groupOfPath('/p/web-worktrees/feature', projects)).toBe('Client A');
		expect(groupOfPath('/p/site/sub', projects)).toBe('Client B');
		expect(groupOfPath('/p/scratch', projects)).toBe(UNGROUPED);
		expect(groupOfPath('/tmp/adhoc', projects)).toBe(UNGROUPED);
		expect(groupOfPath('', projects)).toBe(UNGROUPED);
	});

	it('trusts the repo a worktree names, wherever the worktree sits', () => {
		const elsewhere = { ...session('w', '/somewhere/else', 0), worktree: { repo: '/p/site', branch: 'b' } } as SessionView;
		expect(groupOfPath(sessionPath(elsewhere), projects)).toBe('Client B');
		expect(inGroup([elsewhere], sessionPath, projects, 'Client B')).toEqual([elsewhere]);
		expect(groupSessions([elsewhere], projects)[0].name).toBe('Client B');
	});

	it('lists All, each group, then Ungrouped', () => {
		expect(groupEntries([], projects).map((e) => e.label)).toEqual(['All', 'Client A', 'Client B', UNGROUPED]);
		expect(groupEntries([], projects)[0].name).toBeNull();
	});

	it('lists Ungrouped only when a project or a session lands there', () => {
		const grouped = projects.filter((p) => p.group);
		expect(groupEntries([], grouped).map((e) => e.label)).toEqual(['All', 'Client A', 'Client B']);
		const adhoc = [session('s', '/tmp/adhoc', 0)];
		expect(groupEntries(adhoc, grouped).map((e) => e.label)).toEqual(['All', 'Client A', 'Client B', UNGROUPED]);
	});

	it('lists nothing when no project has a group', () => {
		expect(groupEntries([session('s', '/tmp', 0)], [project('scratch', '/p/scratch')])).toEqual([]);
	});

	it('counts asking and unread per group, leaving out hidden and quiet sessions', () => {
		const entries = groupEntries(
			[
				asking('a', '/p/web-worktrees/feature'),
				unread('b', '/p/api'),
				session('quiet', '/p/web', 0),
				{ ...asking('gone', '/p/site'), hidden: true },
				asking('c', '/tmp/adhoc')
			],
			projects
		);
		expect(Object.fromEntries(entries.map((e) => [e.label, e.count]))).toEqual({
			All: 3,
			'Client A': 2,
			'Client B': 0,
			[UNGROUPED]: 1
		});
	});

	it('flags waiting in another group only', () => {
		const entries = groupEntries([asking('a', '/p/web')], projects);
		expect(waitingElsewhere(entries, 'Client B')).toBe(true);
		expect(waitingElsewhere(entries, 'Client A')).toBe(false);
		expect(waitingElsewhere(entries, null)).toBe(false);
	});

	it('falls back to All when the picked group has gone', () => {
		const entries = groupEntries([], projects);
		expect(resolveGroup('Client A', entries)).toBe('Client A');
		expect(resolveGroup('Deleted', entries)).toBeNull();
		expect(resolveGroup(null, entries)).toBeNull();
		expect(resolveGroup('Client A', [])).toBeNull();
	});

	it('filters to the selected group, and All keeps everything', () => {
		const sessions = [
			session('wt', '/p/web-worktrees/feature', 0),
			session('b', '/p/site', 0),
			session('adhoc', '/tmp/adhoc', 0)
		];
		const ids = (selected: string | null) => inGroup(sessions, (s) => s.cwd, projects, selected).map((s) => s.id);
		expect(ids('Client A')).toEqual(['wt']);
		expect(ids(UNGROUPED)).toEqual(['adhoc']);
		expect(ids(null)).toEqual(['wt', 'b', 'adhoc']);
	});

	it('keeps a hidden project in its group for the Hidden section', () => {
		const hiding = [{ ...project('web', '/p/web', 'Client A'), hidden: true }, project('site', '/p/site', 'Client B')];
		const sessions = [{ ...session('h', '/p/web', 0), hidden: true }, session('b', '/p/site', 0)];
		const shown = inGroup(sessions, (s) => s.cwd, hiding, 'Client A');
		expect(hiddenGroup(shown, hiding)?.subgroups[0].sessions.map((s) => s.id)).toEqual(['h']);
		expect(groupEntries([], hiding).map((e) => e.label)).toContain('Client A');
	});

	it('follows an opened session to its group, unless on All', () => {
		const other = session('o', '/p/site', 0);
		expect(groupAfterOpening(other, projects, 'Client A')).toBe('Client B');
		expect(groupAfterOpening(session('m', '/p/web', 0), projects, 'Client A')).toBe('Client A');
		expect(groupAfterOpening(other, projects, null)).toBeNull();
	});

	it('orders the picker with the group first and the rest under Other groups', () => {
		const withHidden = [...projects, { ...project('old', '/p/old', 'Client A'), hidden: true }];
		expect(pickerGroups(withHidden, 'Client B').map((g) => [g.name, g.projects.map((p) => p.name)])).toEqual([
			['Client B', ['site']],
			[OTHER_GROUPS, ['api', 'scratch', 'web']],
			[HIDDEN, ['old']]
		]);
		expect(pickerGroups(projects, null).map((g) => g.name)).toEqual(['Client A', 'Client B', UNGROUPED]);
	});

	it('starts in the selected group, keeping a pick that fits', () => {
		expect(startProject(projects, 'Client A', '/p/site')).toBe('/p/api');
		expect(startProject(projects, 'Client A', '/p/web')).toBe('/p/web');
		expect(startProject(projects, 'Client A', '')).toBe('/p/api');
		expect(startProject(projects, null, '/p/site')).toBe('/p/site');
		expect(startProject(projects, null, '')).toBe('/p/web');
	});
});
