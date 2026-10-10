import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionOr404 } from '$lib/server/http';
import { listSessionDir } from '$lib/server/file-browser';

// One folder of the session's Files tab: GET ?path=<relative to the session's
// folder>. Files themselves are served by ../files (the same confinement).
export const GET: RequestHandler = async ({ params, url }) => {
	const session = await sessionOr404(params.id);
	const result = listSessionDir(session, url.searchParams.get('path') ?? '');
	if (!result.ok) error(result.status, result.message);
	return json(result.listing);
};
