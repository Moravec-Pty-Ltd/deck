import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, answerText, objectBody } from '$lib/server/http';
import { resolveAsk } from '$lib/server/ask';
import { resolveWorkflowAsk } from '$lib/server/workflows';

// Resolve a pending ask listed by GET /api/agent/asks. MCP asks resolve by
// text alone; workflow checkpoints additionally need the listed askId (an
// answer must not unblock a checkpoint it wasn't aimed at).
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);
	const text = answerText(body);
	const ok =
		resolveAsk(session.id, text) ||
		resolveWorkflowAsk(session.id, String(body.askId ?? ''), text);
	return json({ ok });
};
