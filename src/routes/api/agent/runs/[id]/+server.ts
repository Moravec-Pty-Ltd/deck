import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRun } from '$lib/server/workflow-store';
import { fullDigest } from '$lib/server/workflow-api';

export const GET: RequestHandler = async ({ params }) => {
	const run = getRun(params.id);
	if (!run) error(404, 'run not found');
	return json(await fullDigest(run));
};
