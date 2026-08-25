import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listAgentModels } from '$lib/server/agents/models';
import { isListableKind } from '$lib/models';

// Only the listable kinds enumerate models; any other kind (or a bogus param)
// resolves to an empty list so the picker falls back to free-text. Fail-soft is
// the whole contract here: this never blocks session creation.
export const GET: RequestHandler = async ({ params }) => {
	if (!isListableKind(params.kind)) return json([]);
	return json(await listAgentModels(params.kind));
};
