import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { objectBody } from '$lib/server/http';
import { listRuns } from '$lib/server/workflow-store';
import { startRun } from '$lib/server/workflow-runner';
import { digest, parseStartRequest } from '$lib/server/workflow-api';

// Workflow runs (issue #233): every run's digest, newest first, and starting one.
export const GET: RequestHandler = async () => {
	return json([...listRuns()].sort((a, b) => b.createdAt - a.createdAt).map(digest));
};

export const POST: RequestHandler = async ({ request }) => {
	const run = await startRun(parseStartRequest(await objectBody(request)));
	return json(digest(run), { status: 201 });
};
