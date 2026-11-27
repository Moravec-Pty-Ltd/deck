import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { revokeDevice } from '$lib/server/devices';

// DELETE /api/agent/devices/<id>: sign that device out for good.
export const DELETE: RequestHandler = async ({ params }) => {
	if (!revokeDevice(params.id)) error(404, 'no such device');
	return json({ ok: true });
};
