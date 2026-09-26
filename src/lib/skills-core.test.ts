import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, skillInvocation, type SkillInfo } from './skills-core';

const skills: SkillInfo[] = [
	{ name: 'dev-workflow', description: 'Work an issue to a PR', scope: 'global' },
	{ name: 'dev', description: 'Something shorter', scope: 'global' },
	{ name: 'code-review', description: 'Review a branch', scope: 'deck' }
];

describe('parseSkillFrontmatter', () => {
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
