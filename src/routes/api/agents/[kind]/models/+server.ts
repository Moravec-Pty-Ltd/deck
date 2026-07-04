import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAgentModels } from '$lib/server/agents/models';

// Only pi/opencode enumerate models; any other kind (or a bogus param) resolves
// to an empty list so the picker falls back to free-text. Fail-soft is the whole
// contract here: this never blocks session creation.
const LISTABLE = ['pi', 'opencode'] as const;

function isListable(kind: string): kind is (typeof LISTABLE)[number] {
	return (LISTABLE as readonly string[]).includes(kind);
}

export const GET: RequestHandler = async ({ params }) => {
	if (!isListable(params.kind)) return json([]);
	return json(await listAgentModels(params.kind));
};
