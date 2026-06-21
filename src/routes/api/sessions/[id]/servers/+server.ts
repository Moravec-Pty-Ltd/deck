import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/sessions';
import { listServers } from '$lib/server/devservers';

// Configured dev servers + live status for the session's worktree (issue #32).
// Auth is enforced globally by hooks.server.ts.
export const GET: RequestHandler = async ({ params }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	return json({ servers: await listServers(params.id) });
};
