import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionOr404 } from '$lib/server/http';
import { hasProcess, sessionAgents } from '$lib/server/claude';

// Every subagent of the session with its full report. The live snapshot leaves
// out the reports of agents launched before its history window; the client
// fetches them here once it scrolls back that far.
export const GET: RequestHandler = async ({ params }) => {
	const session = await sessionOr404(params.id);
	return json(sessionAgents(session.id, session.kind !== 'claude' || hasProcess(session.id)));
};
