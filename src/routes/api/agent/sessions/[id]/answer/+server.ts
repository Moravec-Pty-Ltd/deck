import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, answerText, objectBody } from '$lib/server/http';
import { hasPendingAsk, resolveAsk } from '$lib/server/ask';
import { resolveWorkflowAsk, workflowAskId, workflowAskPending } from '$lib/server/workflows';
import { classifyAnswerFailure } from '$lib/server/agent-answer-core';
import { currentLogSeq } from '$lib/server/event-log';

// Resolve a pending ask listed by GET /api/agent/asks. MCP asks resolve by text
// alone; workflow checkpoints additionally need the listed askId (an answer must
// not unblock a checkpoint it wasn't aimed at). On success returns
// { ok:true, seq } (the event-log cursor, to correlate the resulting turn); on
// failure { ok:false, reason } disambiguates why nothing was resolved.
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);
	const text = answerText(body);
	const askId = String(body.askId ?? '');
	const ok = resolveAsk(session.id, text) || resolveWorkflowAsk(session.id, askId, text);
	if (ok) return json({ ok: true, seq: currentLogSeq() });
	return json({
		ok: false,
		reason: classifyAnswerFailure({
			mcpPending: hasPendingAsk(session.id),
			wfPending: workflowAskPending(session.id),
			providedAskId: askId,
			wfAskId: workflowAskId(session.id)
		})
	});
};
