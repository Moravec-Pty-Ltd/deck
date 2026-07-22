import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, answerText, objectBody } from '$lib/server/http';
import { resolveAsk } from '$lib/server/ask';
import { currentLogSeq } from '$lib/server/event-log';

// Resolve a pending ask listed by GET /api/agent/asks. Asks resolve by text
// alone. On success returns { ok:true, seq } (the event-log cursor, to correlate
// the resulting turn); on failure { ok:false, reason:'no-pending-ask' } (nothing
// was waiting: already answered, or a race).
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);
	const text = answerText(body);
	if (resolveAsk(session.id, text)) return json({ ok: true, seq: currentLogSeq() });
	return json({ ok: false, reason: 'no-pending-ask' });
};
