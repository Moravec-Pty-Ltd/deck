import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MIN_QUERY_CHARS, normaliseQuery } from '$lib/search-core';
import { SEARCH_LIMIT_MAX, searchTranscripts } from '$lib/server/search';

// Full-text search over what was said in every agent session. `q` is a plain
// case-insensitive substring; hits carry the session and the event index so a
// client can open the session at that point (/s/{id}?at={index}).
export const GET: RequestHandler = async ({ url }) => {
	const q = normaliseQuery(url.searchParams.get('q'));
	if (q.length < MIN_QUERY_CHARS) error(400, `query must be at least ${MIN_QUERY_CHARS} characters`);
	const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Number(url.searchParams.get('limit')) || 30));
	return json({ query: q, ...(await searchTranscripts(q, limit)) });
};
