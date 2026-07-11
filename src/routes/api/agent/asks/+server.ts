import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listPendingAsks } from '$lib/server/ask';
import { listWorkflowAsks } from '$lib/server/workflows';

// Everything currently blocking on a human answer, across all sessions: MCP
// asks and workflow checkpoints, with the questions and options inline so an
// orchestrator can answer (POST /api/agent/sessions/[id]/answer) without
// parsing deck.ask events off an SSE stream.
export const GET: RequestHandler = async () => {
	return json(
		[...listPendingAsks(), ...listWorkflowAsks()].sort((a, b) => a.askedAt - b.askedAt)
	);
};
