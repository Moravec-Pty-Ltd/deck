import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { objectBody } from '$lib/server/http';
import { markRead } from '$lib/server/unread';

// Mark sessions read, for the browser and the apps alike; see unread.ts.
export const POST: RequestHandler = async ({ request }) => {
	const { ids } = await objectBody(request);
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) error(400, 'ids must be an array of strings');
	return json({ ok: true, unreadCount: markRead(ids) });
};
