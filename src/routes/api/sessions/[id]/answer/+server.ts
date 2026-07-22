import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, answerText, objectBody } from '$lib/server/http';
import { resolveAsk } from '$lib/server/ask';
import { recordAnswer } from '$lib/server/claude';

// Persist the picked options against the ask they answer, when the client sent
// them (free-text-only answers carry no structured picks).
function recordIfAnswers(id: string, body: Record<string, unknown>) {
	if (typeof body.toolUseId === 'string' && Array.isArray(body.answers)) {
		recordAnswer(id, body.toolUseId, body.answers);
	}
}

// Answer a blocking MCP `ask` (claude only). Records the picked options on the
// transcript (for display/persistence) and resolves the pending entry so the
// turn continues.
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);
	const text = answerText(body);
	recordIfAnswers(session.id, body);
	return json({ ok: resolveAsk(session.id, text) });
};
