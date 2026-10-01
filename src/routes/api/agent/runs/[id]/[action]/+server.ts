import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { optionalObjectBody } from '$lib/server/http';
import { isRunAction, runAction } from '$lib/server/workflow-runner';
import { digest } from '$lib/server/workflow-api';

// One control on a run: pause, takeover, resume, retry, cancel, answer, block,
// agent, note, handoff, message. Each takes an optional `reason` and `by`
// ("human" or "overseer"), recorded as a decision on the run's current phase.
export const POST: RequestHandler = async ({ params, request }) => {
	if (!isRunAction(params.action)) error(404, 'unknown run action');
	const body = await optionalObjectBody(request);
	return json(digest(await runAction(params.id, params.action, body)));
};
