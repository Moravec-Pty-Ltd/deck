import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSessions } from '$lib/server/sessions';
import { createSessionFromRequest } from '$lib/server/create-session';
import { objectBody } from '$lib/server/http';

export const GET: RequestHandler = async () => {
	return json(await listSessions());
};

// The create pipeline lives in $lib/server/create-session.ts so the agent API
// (POST /api/agent/sessions) shares one implementation. objectBody keeps a
// non-object JSON body a clean 400 instead of a destructuring 500.
export const POST: RequestHandler = async ({ request }) => {
	const session = await createSessionFromRequest(await objectBody(request));
	return json(session, { status: 201 });
};
