import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, SkillStatus } from '$lib/types';
import { AGENT_BINARIES } from './agents/binaries';
import { agentAvailability } from './agents/available';
import { parseSkillVersion, skillStatus } from './skills-core';
// The repo's canonical skill, bundled at build time so the running server can
// serve its version and install it without depending on the source tree.
import shippedSkillMd from '../../../.claude/skills/deck/SKILL.md?raw';

const SKILL_NAME = 'deck';

// Where each harness keeps user-level skills. null = deck doesn't know a skill
// dir for that harness yet; the panel shows it as unsupported. Extend as the
// other harnesses grow skill support.
const SKILL_DIRS: Record<AgentKind, string | null> = {
	claude: path.join(os.homedir(), '.claude', 'skills'),
	pi: null,
	codex: null,
	opencode: null
};

export const shippedSkillVersion = parseSkillVersion(shippedSkillMd);

function installedSkillPath(kind: AgentKind): string | null {
	const dir = SKILL_DIRS[kind];
	return dir ? path.join(dir, SKILL_NAME, 'SKILL.md') : null;
}

function readInstalled(kind: AgentKind): string | null {
	const file = installedSkillPath(kind);
	if (!file) return null;
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

// One row per harness deck can drive, availability probed live (same source as
// the new-session modal's kind picker).
export async function listSkillStatuses(): Promise<SkillStatus[]> {
	const available = await agentAvailability();
	return (Object.keys(AGENT_BINARIES) as AgentKind[]).map((kind) =>
		skillStatus({
			kind,
			available: available[kind],
			supported: SKILL_DIRS[kind] !== null,
			installedMd: readInstalled(kind),
			shippedVersion: shippedSkillVersion
		})
	);
}

// Copy the shipped skill into the harness's skill dir (install and update are
// the same write). The target path is fixed server-side per harness, never
// request-derived, so this deliberate out-of-project write stays confined to
// the known skill dirs. `available` is the caller's live probe result, passed
// through so the returned row doesn't contradict a later GET.
export function installSkill(kind: AgentKind, available: boolean): SkillStatus {
	const file = installedSkillPath(kind);
	if (!file) throw new Error(`no known skill directory for ${kind}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, shippedSkillMd);
	return skillStatus({
		kind,
		available,
		supported: true,
		installedMd: shippedSkillMd,
		shippedVersion: shippedSkillVersion
	});
}
