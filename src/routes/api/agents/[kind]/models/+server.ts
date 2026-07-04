import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AgentKind } from '$lib/types';
import { listAgentModels } from '$lib/server/agents/models';

// Only pi/opencode enumerate models; any other kind (or a bogus param) resolves
// to an empty list so the picker falls back to free-text. Fail-soft is the whole
// contract here: this never blocks session creation.
const LISTABLE: AgentKind[] = ['pi', 'opencode'];

export const GET: RequestHandler = async ({ params }) => {
	const kind = params.kind as AgentKind;
	if (!LISTABLE.includes(kind)) return json([]);
	return json(await listAgentModels(kind));
};
