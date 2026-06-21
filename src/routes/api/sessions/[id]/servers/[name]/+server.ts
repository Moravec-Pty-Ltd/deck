import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startServer, stopServer, restartServer } from '$lib/server/devservers';

// Start / stop / restart one configured dev server. The action targets the
// session's *own* worktree (resolved server-side from the stored session), never
// a request-supplied path.
const ACTIONS = { start: startServer, stop: stopServer, restart: restartServer };

export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json().catch(() => ({}));
	const action = ACTIONS[body.action as keyof typeof ACTIONS];
	if (!action) error(400, 'invalid action');
	try {
		return json(await action(params.id, params.name));
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to run action');
	}
};
