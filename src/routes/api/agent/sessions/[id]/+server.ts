import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/sessions';
import { sessionDigest } from '$lib/server/agent-digest';
import { deleteSessionRoute } from '$lib/server/http';

// One session's digest, with `lastResult` (the session's most recent assistant
// reply) attached so an orchestrator can read what it produced without a separate
// transcript call. 404 when unknown.
export const GET: RequestHandler = async ({ params }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	return json(sessionDigest(session, { lastResult: true }));
};

// Teardown, same handler as the internal DELETE /api/sessions/[id].
export const DELETE: RequestHandler = deleteSessionRoute;
