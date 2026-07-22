import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listPendingAsks } from '$lib/server/ask';

// Every MCP `ask` currently blocking on a human answer, across all sessions,
// oldest first, with the questions and options inline so an orchestrator can
// answer (POST /api/agent/sessions/[id]/answer) without parsing events off an
// SSE stream.
export const GET: RequestHandler = async () => {
	return json([...listPendingAsks()].sort((a, b) => a.askedAt - b.askedAt));
};
