import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/sessions';
import { readTranscriptRange } from '$lib/server/claude';

// Older history for back-scroll: the snapshot in /events only carries recent
// events, so the client fetches earlier slices here on demand.
export const GET: RequestHandler = async ({ params, url }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	const before = Number(url.searchParams.get('before')) || 0;
	const limit = Number(url.searchParams.get('limit')) || 200;
	return json(readTranscriptRange(params.id, before, limit));
};
