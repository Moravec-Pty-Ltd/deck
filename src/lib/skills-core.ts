// Reading and invoking the skills installed on this machine. Node-free: the
// fs walk that finds them is in server/skills-catalogue.ts, and the agent API
// serves the result at /api/agent/skills.

export interface SkillInfo {
	name: string;
	description: string;
	// 'global' for ~/.claude/skills, else the project the skill belongs to.
	scope: string;
}

// `name` and `description` from a SKILL.md's frontmatter.
export function parseSkillFrontmatter(markdown: string): { name?: string; description?: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	if (!match) return {};
	const out: { name?: string; description?: string } = {};
	for (const line of match[1].split(/\r?\n/)) {
		const m = /^(name|description):\s*(.*)$/.exec(line);
		if (m) out[m[1] as 'name' | 'description'] = m[2].trim().replace(/^["']|["']$/g, '');
	}
	return out;
}

// Turn spoken phrasing into the slash command that actually runs a skill:
// "run dev-workflow on ENG-1" becomes "/dev-workflow ENG-1". A voice client
// says what a person would say, and a harness only runs a skill when the
// message starts with its name as a command. Longest name first, so
// `dev-workflow` wins over a hypothetical `dev`. Text that is already a
// command, or that names no skill, is returned as it came.
export function skillInvocation(text: string, skills: SkillInfo[]): string {
	const trimmed = text.trim();
	if (trimmed.startsWith('/')) return trimmed;
	const names = skills.map((s) => s.name).sort((a, b) => b.length - a.length);
	for (const name of names) {
		const pattern = new RegExp(
			`^(?:please\\s+)?(?:run|start|use|do|kick off)?\\s*(?:the\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+skill)?(?:\\s+(?:on|for|with|against))?\\b\\s*(.*)$`,
			'i'
		);
		const m = pattern.exec(trimmed);
		if (m) return `/${name}${m[1] ? ` ${m[1].trim()}` : ''}`;
	}
	return trimmed;
}

// The registered project a session's cwd belongs to (the project itself, a dir
// inside it, or one of deck's `<project>-worktrees/` checkouts), deepest match
// first because projects nest. Mirrors server/confine.ts projectForPath on the
// client, without the symlink canonicalisation.
export function projectNameForCwd(cwd: string, projects: { path: string; name: string }[]): string | null {
	let best: { path: string; name: string } | null = null;
	for (const p of projects) {
		const base = p.path.replace(/\/+$/, '');
		const owns = cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}-worktrees/`);
		if (owns && (!best || base.length > best.path.length)) best = { path: base, name: p.name };
	}
	return best?.name ?? null;
}

// How well a skill matches what was typed: lower is better, null is no match.
function matchRank(skill: SkillInfo, q: string): number | null {
	const name = skill.name.toLowerCase();
	if (!q) return 0;
	if (name === q) return 0;
	if (name.startsWith(q)) return 1;
	if (name.split(/[-_:.\s]+/).some((part) => part.startsWith(q))) return 2;
	if (name.includes(q)) return 3;
	if (skill.description.toLowerCase().includes(q)) return 4;
	return null;
}

// The skills a composer offers in a session: global ones plus the session
// project's own, a project skill shadowing a global of the same name (as the
// harness resolves it), filtered by the typed query and ranked name-prefix
// first, then word-prefix, substring, and description match; project skills
// ahead of global ones within a rank, then alphabetical.
export function rankSkills(skills: SkillInfo[], query: string, project: string | null): SkillInfo[] {
	const byName = new Map<string, SkillInfo>();
	for (const s of skills) {
		if (s.scope !== 'global' && s.scope !== project) continue;
		const prev = byName.get(s.name);
		if (!prev || prev.scope === 'global') byName.set(s.name, s);
	}
	const q = query.trim().replace(/^\//, '').toLowerCase();
	const ranked: { skill: SkillInfo; rank: number }[] = [];
	for (const skill of byName.values()) {
		const rank = matchRank(skill, q);
		if (rank !== null) ranked.push({ skill, rank });
	}
	return ranked
		.sort(
			(a, b) =>
				a.rank - b.rank ||
				Number(a.skill.scope === 'global') - Number(b.skill.scope === 'global') ||
				a.skill.name.localeCompare(b.skill.name)
		)
		.map((r) => r.skill);
}

// The skill name being typed when the composer holds only a leading `/token`
// (no space yet), which is when the "/" trigger opens the list; else null.
export function slashQuery(text: string): string | null {
	const m = /^\/([^\s/]*)$/.exec(text);
	return m ? m[1] : null;
}

// The composer text after picking a skill: `/name ` replacing any leading
// `/token` already typed, ahead of whatever else was there.
export function insertSkill(text: string, name: string): string {
	const rest = text.replace(/^\/\S*\s*/, '').replace(/^\s+/, '');
	return `/${name} ${rest}`;
}
