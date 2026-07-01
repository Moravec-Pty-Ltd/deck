import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProjectIssues } from '$lib/server/issues';
import { projectFromQuery } from '$lib/server/project-query';

// GET /api/issues?project=<path>[&refresh=1]
// Aggregated, recency-sorted issues across the project's sources. Served from a
// 60s in-memory cache unless refresh is set.
export const GET: RequestHandler = async ({ url }) => {
	const { project, refresh } = projectFromQuery(url);
	return json(await getProjectIssues(project, refresh));
};
