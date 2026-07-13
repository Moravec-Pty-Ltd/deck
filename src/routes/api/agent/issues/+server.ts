import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProjectIssues } from '$lib/server/issues';
import { projectFromQuery } from '$lib/server/project-query';
import { issueDigest } from '$lib/server/agent-digest';

// Agent projection of a project's open issues (issue #144): each row maps onto
// create's `issue { source, id, url }`. GET /api/agent/issues?project=<path>
// (path from GET /api/agent/projects); ?refresh=1 bypasses the 60s cache. A
// per-source failure surfaces in `errors`, not by sinking the list.
export const GET: RequestHandler = async ({ url }) => {
	const { project, refresh } = projectFromQuery(url);
	const { issues, errors } = await getProjectIssues(project, refresh);
	return json({ issues: issues.map(issueDigest), errors });
};
