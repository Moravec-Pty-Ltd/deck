import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { registerDevice } from '$lib/server/apns';

// A schema mismatch is a 400, not a 500 (see registerDevice / quick-messages'
// PUT for the same pattern).
export const POST: RequestHandler = async ({ request }) => {
	try {
		registerDevice(await request.json());
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid device');
	}
	return json({ ok: true });
};
