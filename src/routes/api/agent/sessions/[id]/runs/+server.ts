import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionOr404 } from '$lib/server/http';
import { digest } from '$lib/server/workflow-api';
import { runsStartedBy } from '$lib/server/workflow-report';

// The workflow runs this session started, newest first.
export const GET: RequestHandler = async ({ params }) => {
	const session = await sessionOr404(params.id);
	return json(runsStartedBy(session.id).sort((a, b) => b.createdAt - a.createdAt).map(digest));
};
