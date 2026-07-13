import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404 } from '$lib/server/http';
import { agentTranscriptView } from '$lib/server/transcript';

// Readable turn output for an agent session (issue #144): recent user/assistant
// messages, the last assistant reply, and the running cost. The digest carries
// status/cost/pr but no text, and `message` only acks with { status:'running' };
// this is where an orchestrator reads what the session actually replied.
export const GET: RequestHandler = async ({ params }) => {
	const session = await agentSessionOr404(params.id);
	return json(agentTranscriptView(session.id));
};
