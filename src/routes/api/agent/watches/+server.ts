import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listWatches } from '$lib/server/watch-store';

// Watches (issue #277): every watch, or one session's with ?sessionId=, active
// ones and those that ended in the last day. Newest first.
export const GET: RequestHandler = async ({ url }) => {
	const watches = listWatches(url.searchParams.get('sessionId') || undefined);
	return json({ watches: [...watches].sort((a, b) => b.createdAt - a.createdAt) });
};
