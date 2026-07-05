import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, objectBody } from '$lib/server/http';
import { resolveAsk } from '$lib/server/ask';
import { resolveWorkflowAsk } from '$lib/server/workflows';
import { recordAnswer } from '$lib/server/claude';

// Persist the picked options against the ask they answer, when the client sent
// them (free-text-only answers carry no structured picks).
function recordIfAnswers(id: string, body: Record<string, unknown>) {
	if (typeof body.toolUseId === 'string' && Array.isArray(body.answers)) {
		recordAnswer(id, body.toolUseId, body.answers);
	}
}

// Answer a blocking ask: the MCP `ask` tool (claude only) or a workflow ask
// step (any agent kind). Records the picked options on the transcript (for
// display/persistence) and resolves whichever pending entry is waiting so the
// turn (or the run) continues.
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);
	const text = String(body.text ?? '').trim();
	if (!text) error(400, 'empty answer');

	recordIfAnswers(session.id, body);
	const ok = resolveAsk(session.id, text) || resolveWorkflowAsk(session.id, text);
	return json({ ok });
};
