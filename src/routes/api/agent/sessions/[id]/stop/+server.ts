import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404 } from '$lib/server/http';
import { agentInterrupt } from '$lib/server/agents/dispatch';

// Interrupt the in-flight turn; `{ force: true }` ends the process instead.
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await request.json().catch(() => ({}));
	const outcome = agentInterrupt(session.id, body?.force === true);
	return json({ ok: true, outcome });
};
