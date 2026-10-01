import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, answerText, objectBody } from '$lib/server/http';
import { answerAsk } from '$lib/server/answer';
import { currentLogSeq } from '$lib/server/event-log';
import { blockedRunForSession, runAction } from '$lib/server/workflow-runner';

// Resolve a pending ask listed by GET /api/agent/asks. `text` answers it;
// `askId` + `answers` (one { header, labels } per question) additionally persist
// the picks on the transcript, the same as the web ask card. On success returns
// { ok:true, seq } (the event-log cursor, to correlate the resulting turn); on
// failure { ok:false, reason:'no-pending-ask' } (nothing was waiting: already
// answered, or a race). A blocked workflow run whose latest phase is this
// session is answered the same way, which resumes the run.
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);
	if (answerAsk(session, body)) return json({ ok: true, seq: currentLogSeq() });
	const run = blockedRunForSession(session.id);
	if (!run) return json({ ok: false, reason: 'no-pending-ask' });
	await runAction(run.id, 'answer', { text: answerText(body) });
	return json({ ok: true, seq: currentLogSeq() });
};
