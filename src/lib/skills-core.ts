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
