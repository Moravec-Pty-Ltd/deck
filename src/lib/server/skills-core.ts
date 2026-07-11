import type { AgentKind } from '$lib/types';

// Pure logic for the deck skill's install/version story (issue #127): parse
// the version out of a SKILL.md and derive one harness's install status. The
// fs/availability wiring lives in skills.ts.

// `version: x.y.z` from the SKILL.md frontmatter block, or null when the file
// has no frontmatter / no version line.
export function parseSkillVersion(md: string): string | null {
	const fm = /^---\n([\s\S]*?)\n---/.exec(md);
	if (!fm) return null;
	const line = /^version:\s*(\S+)\s*$/m.exec(fm[1]);
	return line ? line[1] : null;
}

// One harness's row in the settings Skills panel. `supported` is whether deck
// knows where that harness keeps skills; unsupported rows render as such
// rather than blocking the panel.
export interface SkillStatus {
	kind: AgentKind;
	available: boolean;
	supported: boolean;
	installed: boolean;
	installedVersion: string | null;
	shippedVersion: string | null;
	upToDate: boolean;
}

export function skillStatus(input: {
	kind: AgentKind;
	available: boolean;
	supported: boolean;
	// contents of the installed SKILL.md, or null when not installed
	installedMd: string | null;
	shippedVersion: string | null;
}): SkillStatus {
	const installed = input.supported && input.installedMd !== null;
	const installedVersion = installed ? parseSkillVersion(input.installedMd!) : null;
	return {
		kind: input.kind,
		available: input.available,
		supported: input.supported,
		installed,
		installedVersion,
		shippedVersion: input.shippedVersion,
		upToDate:
			installed && installedVersion !== null && installedVersion === input.shippedVersion
	};
}
