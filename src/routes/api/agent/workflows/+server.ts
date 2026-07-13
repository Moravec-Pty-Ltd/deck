import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { projectFromQuery } from '$lib/server/project-query';
import { startableWorkflows } from '$lib/server/agent-digest';

// Startable workflows for a project (issue #144): id / name / context / steps,
// for GET /api/agent/workflows?project=<path>. The synthesized legacy New/Review
// pair is excluded — those are the plain new-session path, not a startable
// workflowId. Attach one at create (`workflowId`) or start it on an existing
// session (POST /api/agent/sessions/{id}/workflow).
export const GET: RequestHandler = ({ url }) => {
	const { project } = projectFromQuery(url);
	return json(startableWorkflows(project));
};
