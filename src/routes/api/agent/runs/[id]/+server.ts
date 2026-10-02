import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRun } from '$lib/server/workflow-store';
import { deleteRun } from '$lib/server/workflow-runner';
import { fullDigest } from '$lib/server/workflow-api';

export const GET: RequestHandler = async ({ params }) => {
	const run = getRun(params.id);
	if (!run) error(404, 'run not found');
	return json(await fullDigest(run));
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	await deleteRun(params.id, { keepSessions: url.searchParams.get('keepSessions') === '1' });
	return json({ ok: true });
};
