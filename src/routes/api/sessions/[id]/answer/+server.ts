import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, objectBody } from '$lib/server/http';
import { answerAsk } from '$lib/server/answer';

// Answer a blocking MCP `ask` (claude only). Records the picked options on the
// transcript (for display/persistence) and resolves the pending entry so the
// turn continues. Same handler as the agent route; this one keeps the browser
// response shape.
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	return json({ ok: answerAsk(session, await objectBody(request)) });
};
