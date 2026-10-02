import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { optionalObjectBody } from '$lib/server/http';
import { overseerStatus, startOverseer, stopOverseer } from '$lib/server/workflow-overseer';
import type { StepAgent } from '$lib/workflows';

// The overseer session that watches workflow runs (issue #233).
export const GET: RequestHandler = async () => json(overseerStatus());

export const POST: RequestHandler = async ({ request }) => {
	const body = await optionalObjectBody(request);
	await startOverseer({ kind: body.kind, model: body.model, effort: body.effort } as StepAgent);
	return json(overseerStatus());
};

export const DELETE: RequestHandler = async () => {
	stopOverseer();
	return json(overseerStatus());
};
