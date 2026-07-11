import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/sessions';
import { sessionDigest } from '$lib/server/agent-digest';
import { deleteSessionRoute } from '$lib/server/http';

export const GET: RequestHandler = async ({ params }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	return json(sessionDigest(session));
};

// Teardown, same handler as the internal DELETE /api/sessions/[id].
export const DELETE: RequestHandler = deleteSessionRoute;
