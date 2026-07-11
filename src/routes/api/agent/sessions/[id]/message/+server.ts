import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { agentSessionOr404, objectBody } from '$lib/server/http';
import { agentSend } from '$lib/server/agents/dispatch';
import { updateSession } from '$lib/server/store';

// Send a prompt / steer the session. Text only (the UI's /send carries images
// and [token] expansion; an orchestrator sends plain instructions). A message
// sent mid-turn is queued (claude) or restarts the turn (per-turn agents).
export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);
	const text = String(body.text ?? '');
	if (!text.trim()) error(400, 'empty prompt');

	// Best-effort recency bump, mirroring /send: never block the send on it.
	try {
		updateSession(session.id, { lastActiveAt: Date.now() });
	} catch (err) {
		console.error(`[deck] failed to persist lastActiveAt for ${session.id}:`, err);
	}
	agentSend(session, text);
	return json({ ok: true, status: 'running' });
};
