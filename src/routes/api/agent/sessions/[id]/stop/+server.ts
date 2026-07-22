import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404 } from '$lib/server/http';
import { agentInterrupt } from '$lib/server/agents/dispatch';

// Interrupt the in-flight turn.
export const POST: RequestHandler = async ({ params }) => {
	const session = await agentSessionOr404(params.id);
	agentInterrupt(session.id);
	return json({ ok: true });
};
