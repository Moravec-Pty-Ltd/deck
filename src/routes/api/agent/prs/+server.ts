import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProjectPrs } from '$lib/server/prs';
import { projectFromQuery } from '$lib/server/project-query';
import { prDigest } from '$lib/server/agent-digest';

// Agent projection of a project's review-requested PRs (issue #144): each row maps
// onto review's `pr { repo, number }`. GET /api/agent/prs?project=<path> (path
// from GET /api/agent/projects); ?refresh=1 bypasses the 60s cache.
export const GET: RequestHandler = async ({ url }) => {
	const { project, refresh } = projectFromQuery(url);
	const { prs, errors } = await getProjectPrs(project, refresh);
	return json({ prs: prs.map(prDigest), errors });
};
