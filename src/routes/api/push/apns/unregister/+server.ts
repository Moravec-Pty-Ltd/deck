import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { unregisterDevice } from '$lib/server/apns';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	if (typeof body.token !== 'string') error(400, 'token required');
	unregisterDevice(body.token);
	return json({ ok: true });
};
