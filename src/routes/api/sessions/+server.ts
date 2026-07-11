import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSessions } from '$lib/server/sessions';
import { createSessionFromRequest } from '$lib/server/create-session';

export const GET: RequestHandler = async () => {
	return json(await listSessions());
};

// The create pipeline lives in $lib/server/create-session.ts so the agent API
// (POST /api/agent/sessions) shares one implementation.
export const POST: RequestHandler = async ({ request }) => {
	const session = await createSessionFromRequest(await request.json());
	return json(session, { status: 201 });
};
