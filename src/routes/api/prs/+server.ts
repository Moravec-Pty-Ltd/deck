import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProjectPrs } from '$lib/server/prs';
import { projectFromQuery } from '$lib/server/project-query';

// GET /api/prs?project=<path>[&refresh=1]
// Open PRs across the project's GitHub sources where review is requested from the
// authenticated user. Served from a 60s in-memory cache unless refresh is set.
export const GET: RequestHandler = async ({ url }) => {
	const { project, refresh } = projectFromQuery(url);
	return json(await getProjectPrs(project, refresh));
};
