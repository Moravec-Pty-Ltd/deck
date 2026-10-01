import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadWorkflows } from '$lib/server/workflow-store';

// The workflow definitions (built-ins merged with ~/.deck/workflows.json), and
// any user definitions that were skipped as malformed.
export const GET: RequestHandler = async () => {
	return json(loadWorkflows());
};
