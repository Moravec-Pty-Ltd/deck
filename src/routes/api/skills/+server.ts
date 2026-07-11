import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AgentKind } from '$lib/types';
import { AGENT_BINARIES } from '$lib/server/agents/binaries';
import { agentAvailability } from '$lib/server/agents/available';
import { installSkill, listSkillStatuses } from '$lib/server/skills';
import { objectBody } from '$lib/server/http';

// Install/version status of the shipped deck skill per harness, for the
// projects page's Agent skills panel (issue #127).
export const GET: RequestHandler = async () => {
	return json(await listSkillStatuses());
};

function kindParam(v: unknown): AgentKind {
	if (typeof v !== 'string' || !Object.hasOwn(AGENT_BINARIES, v)) error(400, 'invalid kind');
	return v as AgentKind;
}

// Install or update the skill for one harness (same write either way).
export const POST: RequestHandler = async ({ request }) => {
	const kind = kindParam((await objectBody(request)).kind);
	const available = (await agentAvailability())[kind];
	try {
		return json(installSkill(kind, available));
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to install skill');
	}
};
