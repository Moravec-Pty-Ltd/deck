import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillFrontmatter, type SkillInfo } from '$lib/skills-core';
import { listProjects } from './store';

// The skills installed on this machine: every SKILL.md under ~/.claude/skills,
// each registered project's .claude/skills, and the skills and commands of the
// enabled Claude Code plugins. Read here rather than in the
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

// Claude Code's record of installed plugins, and the user settings that can
// switch one off. A plugin counts when it is installed for the user (not just
// for one project's checkout) and not set to false in enabledPlugins.
function readJson(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

type PluginInstall = { scope?: string; installPath?: unknown };

function userInstallPath(installs: unknown): string | null {
	if (!Array.isArray(installs)) return null;
	const user = (installs as PluginInstall[]).find((i) => i?.scope === 'user' && typeof i.installPath === 'string');
	return (user?.installPath as string) ?? null;
}

function pluginDirs(): { plugin: string; dir: string }[] {
	const root = path.join(os.homedir(), '.claude');
	const installed = (readJson(path.join(root, 'plugins', 'installed_plugins.json'))?.plugins ?? {}) as Record<string, unknown>;
	const enabled = (readJson(path.join(root, 'settings.json'))?.enabledPlugins ?? {}) as Record<string, unknown>;
	return Object.entries(installed).flatMap(([key, installs]) => {
		const dir = enabled[key] === false ? null : userInstallPath(installs);
		return dir ? [{ plugin: key.split('@')[0], dir }] : [];
	});
}

// The manifest's own skills or commands entry: a path or a list of them,
// relative to the plugin. A path that climbs out of the plugin is ignored.
function manifestPaths(dir: string, field: 'skills' | 'commands'): string[] {
	const value = readJson(path.join(dir, '.claude-plugin', 'plugin.json'))?.[field];
	const list = Array.isArray(value) ? value : [value];
	return list
		.filter((v): v is string => typeof v === 'string')
		.map((v) => path.resolve(dir, v))
		.filter((p) => p === dir || p.startsWith(dir + path.sep));
}

const isFile = (file: string) => {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
};

// A skills path is one skill (it holds a SKILL.md) or a folder of them.
function skillFiles(entry: string): [string, string][] {
	const own = path.join(entry, 'SKILL.md');
	if (isFile(own)) return [[path.basename(entry), own]];
	return safeReaddir(entry)
		.map((name): [string, string] => [name, path.join(entry, name, 'SKILL.md')])
		.filter(([, file]) => isFile(file));
}

// A commands path is one .md file or a folder of them.
function commandFiles(entry: string): [string, string][] {
	const files = entry.endsWith('.md') ? [entry] : safeReaddir(entry).map((f) => path.join(entry, f));
	return files.filter((f) => f.endsWith('.md') && isFile(f)).map((f) => [path.basename(f, '.md'), f]);
}

// A plugin's skills then commands as [name, file]: the default skills/ and
// commands/ folders plus any paths its manifest lists (some plugins keep skills
// in category folders such as skills/engineering/<name>).
function pluginEntries(dir: string): [string, string][] {
	return [
		...[path.join(dir, 'skills'), ...manifestPaths(dir, 'skills')].flatMap(skillFiles),
		...[path.join(dir, 'commands'), ...manifestPaths(dir, 'commands')].flatMap(commandFiles)
	];
}

// Every plugin skill and command, named `plugin:name` the way the harness runs
// them. The first of a name wins, so a skill beats a command of the same name.
function pluginSkills(): SkillInfo[] {
	const skills: SkillInfo[] = [];
	for (const { plugin, dir } of pluginDirs()) {
		const seen = new Set<string>();
		for (const [name, file] of pluginEntries(dir)) {
			if (seen.has(name)) continue;
			seen.add(name);
			const skill = readSkill(file, 'global', name);
			if (skill) skills.push({ ...skill, name: `${plugin}:${name}` });
		}
	}
	return skills;
}

function safeReaddir(dir: string): string[] {
	try {
		return fs.readdirSync(dir).sort();
	} catch {
		return [];
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
	return [...skills, ...pluginSkills()];
}

// One skill's full text, or null when no directory holds it. The name is used
// as a path segment, so anything that could climb out of a skills directory is
// refused rather than sanitised: a skill name is a plain directory name.
export function skillBody(name: string): string | null {
	if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
	const [plugin, inPlugin] = name.split(':', 2);
	if (inPlugin) {
		const dir = pluginDirs().find((p) => p.plugin === plugin)?.dir;
		if (!dir) return null;
		const file = pluginEntries(dir).find(([n]) => n === inPlugin)?.[1];
		return file ? fs.readFileSync(file, 'utf8').slice(0, SKILL_BODY_CHARS) : null;
	}
	for (const { dir } of skillDirs()) {
		try {
			return fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8').slice(0, SKILL_BODY_CHARS);
		} catch {
			// Not in this dir.
		}
	}
	return null;
}
