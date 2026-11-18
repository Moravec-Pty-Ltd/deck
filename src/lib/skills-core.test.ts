import { describe, expect, it } from 'vitest';
import {
	insertSkill,
	parseSkillFrontmatter,
	projectNameForCwd,
	rankSkills,
	skillInvocation,
	slashQuery,
	type SkillInfo
} from './skills-core';

const skills: SkillInfo[] = [
	{ name: 'dev-workflow', description: 'Work an issue to a PR', scope: 'global' },
	{ name: 'dev', description: 'Something shorter', scope: 'global' },
	{ name: 'code-review', description: 'Review a branch', scope: 'deck' }
];

describe('parseSkillFrontmatter', () => {
	it('folds a block scalar description onto one line', () => {
		expect(parseSkillFrontmatter('---\nname: audit\ndescription: >\n  Audit the site\n  and report.\nversion: 1\n---\n')).toEqual({
			name: 'audit',
			description: 'Audit the site and report.'
		});
	});

	it('reads name and description out of the frontmatter', () => {
		expect(parseSkillFrontmatter('---\nname: handoff\ndescription: Write a handoff\n---\n# Handoff')).toEqual({
			name: 'handoff',
			description: 'Write a handoff'
		});
	});

	it('strips the quotes a description is often wrapped in', () => {
		expect(parseSkillFrontmatter('---\nname: x\ndescription: "Quoted, with a comma"\n---').description).toBe(
			'Quoted, with a comma'
		);
	});

	it('gives nothing back for a file with no frontmatter', () => {
		expect(parseSkillFrontmatter('# Just a heading')).toEqual({});
		expect(parseSkillFrontmatter('')).toEqual({});
	});
});

describe('skillInvocation', () => {
	it('turns spoken phrasing into the command that runs the skill', () => {
		expect(skillInvocation('run dev-workflow on ENG-1', skills)).toBe('/dev-workflow ENG-1');
		expect(skillInvocation('please use the code-review skill for this branch', skills)).toBe('/code-review this branch');
		expect(skillInvocation('dev-workflow ENG-2', skills)).toBe('/dev-workflow ENG-2');
	});

	it('prefers the longest matching name, so a prefix skill cannot steal it', () => {
		expect(skillInvocation('run dev-workflow ENG-1', skills)).toBe('/dev-workflow ENG-1');
	});

	it('leaves a command, and text naming no skill, exactly as it came', () => {
		expect(skillInvocation('/dev-workflow ENG-1', skills)).toBe('/dev-workflow ENG-1');
		expect(skillInvocation('  /compact keep the goal  ', skills)).toBe('/compact keep the goal');
		expect(skillInvocation('have a look at the auth bug', skills)).toBe('have a look at the auth bug');
		expect(skillInvocation('run the tests', skills)).toBe('run the tests');
	});

	it('handles a skill named on its own, with no arguments', () => {
		expect(skillInvocation('run code-review', skills)).toBe('/code-review');
	});

	it('does not treat a regex character in a skill name as a pattern', () => {
		const odd: SkillInfo[] = [{ name: 'c++.notes', description: '', scope: 'global' }];
		expect(skillInvocation('run c++.notes now', odd)).toBe('/c++.notes now');
		expect(skillInvocation('run cxxXnotes now', odd)).toBe('run cxxXnotes now');
	});
});

describe('projectNameForCwd', () => {
	const projects = [
		{ path: '/path/to/code', name: 'code' },
		{ path: '/path/to/code/acme', name: 'acme' }
	];

	it('maps a project, a dir inside it and its worktrees to the project', () => {
		expect(projectNameForCwd('/path/to/code/acme', projects)).toBe('acme');
		expect(projectNameForCwd('/path/to/code/acme/apps/web', projects)).toBe('acme');
		expect(projectNameForCwd('/path/to/code/acme-worktrees/feature', projects)).toBe('acme');
	});

	it('picks the deepest of nested projects, and null outside all of them', () => {
		expect(projectNameForCwd('/path/to/code/other', projects)).toBe('code');
		expect(projectNameForCwd('/path/to/code/acmeish', projects)).toBe('code');
		expect(projectNameForCwd('/elsewhere', projects)).toBeNull();
	});
});

describe('rankSkills', () => {
	const all: SkillInfo[] = [
		{ name: 'dev-workflow', description: 'Work an issue to a PR', scope: 'global' },
		{ name: 'dev-review', description: 'Review a branch', scope: 'global' },
		{ name: 'code-review', description: 'Review a PR', scope: 'acme' },
		{ name: 'deploy', description: 'Ship it', scope: 'other' },
		{ name: 'release', description: 'Cut a release, global copy', scope: 'global' },
		{ name: 'release', description: 'Cut a release, project copy', scope: 'acme' }
	];
	const names = (q: string, project: string | null = 'acme') => rankSkills(all, q, project).map((s) => s.name);

	it('offers global skills and only the session project skills', () => {
		expect(names('')).toEqual(['code-review', 'release', 'dev-review', 'dev-workflow']);
		expect(names('', null)).toEqual(['dev-review', 'dev-workflow', 'release']);
	});

	it('lets a project skill shadow a global one of the same name', () => {
		const release = rankSkills(all, 'release', 'acme');
		expect(release).toHaveLength(1);
		expect(release[0].scope).toBe('acme');
	});

	it('ranks name prefix, then word prefix, then substring, then description', () => {
		expect(names('rev')).toEqual(['code-review', 'dev-review']);
		expect(names('dev')).toEqual(['dev-review', 'dev-workflow']);
		expect(names('view')).toEqual(['code-review', 'dev-review']);
		expect(names('issue')).toEqual(['dev-workflow']);
		expect(names('re')).toEqual(['release', 'code-review', 'dev-review']);
	});

	it('ignores a leading slash and case, and returns nothing for no match', () => {
		expect(names('/DEV-W')).toEqual(['dev-workflow']);
		expect(names('zzz')).toEqual([]);
	});
});

describe('slashQuery', () => {
	it('reads the name being typed after a leading slash', () => {
		expect(slashQuery('/')).toBe('');
		expect(slashQuery('/dev-w')).toBe('dev-w');
	});

	it('is null once there is a space, or without a leading slash', () => {
		expect(slashQuery('/dev ')).toBeNull();
		expect(slashQuery('hello /dev')).toBeNull();
		expect(slashQuery('/path/to')).toBeNull();
		expect(slashQuery('')).toBeNull();
	});
});

describe('insertSkill', () => {
	it('puts the command ahead of the text, replacing a typed /token', () => {
		expect(insertSkill('', 'dev-workflow')).toBe('/dev-workflow ');
		expect(insertSkill('/dev', 'dev-workflow')).toBe('/dev-workflow ');
		expect(insertSkill('/old ENG-1', 'dev-workflow')).toBe('/dev-workflow ENG-1');
		expect(insertSkill('  ENG-1', 'dev-workflow')).toBe('/dev-workflow ENG-1');
	});
});
