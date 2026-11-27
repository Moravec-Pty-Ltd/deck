import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rotateToken } from '$lib/server/config';

// POST /api/agent/token: rotate deck's token. The old one stops working at once,
// with every agent token derived from it; signed-in devices keep their own
// credentials. The new token is in the token file, never in a response.
export const POST: RequestHandler = async () => {
	try {
		rotateToken();
	} catch (e) {
		error(409, e instanceof Error ? e.message : 'could not rotate the token');
	}
	return json({ ok: true });
};
