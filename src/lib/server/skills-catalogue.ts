import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillFrontmatter, type SkillInfo } from '$lib/skills-core';
import { listProjects } from './store';

// The skills installed on this machine: every SKILL.md under ~/.claude/skills
// and each registered project's .claude/skills. Read here rather than in the
// operator because a client driving deck needs the same list to know what it
// can ask a session to run (see /api/agent/skills).

// How much of a SKILL.md to hand back. A skill is documentation, and the whole
// of a long one would swamp the context of whatever asked for it.
const SKILL_BODY_CHARS = 6000;

function skillDirs(): { dir: string; scope: string }[] {
	const dirs = [{ dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'global' }];
	for (const p of listProjects()) dirs.push({ dir: path.join(p.path, '.claude', 'skills'), scope: p.name });
	return dirs;
}

function readSkill(file: string, scope: string, fallbackName: string): SkillInfo | null {
	try {
		const meta = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
		return { name: meta.name || fallbackName, description: meta.description || '', scope };
	} catch {
		return null;
	}
}

export function skillCatalogue(): SkillInfo[] {
	const skills: SkillInfo[] = [];
	for (const { dir, scope } of skillDirs()) {
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const skill = readSkill(path.join(dir, name, 'SKILL.md'), scope, name);
			if (skill) skills.push(skill);
		}
	}
	return skills;
}

// One skill's full text, or null when no directory holds it. The name is used
// as a path segment, so anything that could climb out of a skills directory is
// refused rather than sanitised: a skill name is a plain directory name.
export function skillBody(name: string): string | null {
	if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
	for (const { dir } of skillDirs()) {
		try {
			return fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8').slice(0, SKILL_BODY_CHARS);
		} catch {
			// Not in this dir.
		}
	}
	return null;
}
