import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, objectBody } from '$lib/server/http';
import { sendAgentMessage } from '$lib/server/send-agent-message';
import { currentLogSeq } from '$lib/server/event-log';

// Shared message behavior with the web route; seq lets callers follow completion.
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);
	const seq = currentLogSeq();
	await sendAgentMessage(session, body);
	return json({ ok: true, status: 'running', seq });
};
