import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listProjects } from '$lib/server/store';
import { getProjectIssues } from '$lib/server/issues';

// GET /api/issues?project=<path>[&refresh=1]
// Aggregated, recency-sorted issues across the project's sources. Served from a
// 60s in-memory cache unless refresh is set.
export const GET: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('project');
	if (!path) error(400, 'project required');
	const project = listProjects().find((p) => p.path === path);
	if (!project) error(404, 'project not found');
	const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
	return json(await getProjectIssues(project, refresh));
};
