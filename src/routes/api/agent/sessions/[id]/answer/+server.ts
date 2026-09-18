import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, objectBody } from '$lib/server/http';
import { answerAsk } from '$lib/server/answer';
import { currentLogSeq } from '$lib/server/event-log';

// Resolve a pending ask listed by GET /api/agent/asks. `text` answers it;
// `askId` + `answers` (one { header, labels } per question) additionally persist
// the picks on the transcript, the same as the web ask card. On success returns
// { ok:true, seq } (the event-log cursor, to correlate the resulting turn); on
// failure { ok:false, reason:'no-pending-ask' } (nothing was waiting: already
// answered, or a race).
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	if (answerAsk(session, await objectBody(request))) return json({ ok: true, seq: currentLogSeq() });
	return json({ ok: false, reason: 'no-pending-ask' });
};
