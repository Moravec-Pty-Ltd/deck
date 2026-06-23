import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	startServer,
	stopServer,
	restartServer,
	resetupServer,
	runSetupStep
} from '$lib/server/devservers';
import { parseStepIndex } from '$lib/server/devservers-core';

// Start / stop / restart / re-run-setup for one configured dev server. Every
// action targets the session's *own* worktree (resolved server-side from the
// stored session), never a request-supplied path.
const ACTIONS = {
	start: startServer,
	stop: stopServer,
	restart: restartServer,
	resetup: resetupServer
} as const;

// Own-property lookup only, so an inherited key (toString, constructor, ...) from
// untrusted input can't slip past the guard into an unexpected call path.
function actionFor(name: unknown) {
	if (typeof name !== 'string') return undefined;
	if (!Object.hasOwn(ACTIONS, name)) return undefined;
	return ACTIONS[name as keyof typeof ACTIONS];
}

// A single-step re-run carries a numeric index plus the label the client rendered
// (so a stale step list is caught server-side). Bad input throws a clean 400.
function stepCall(body: { step?: unknown; label?: unknown }, id: string, name: string) {
	const index = parseStepIndex(body.step);
	if (index === null) error(400, 'invalid step index');
	if (body.label !== undefined && typeof body.label !== 'string') error(400, 'invalid step label');
	return () => runSetupStep(id, name, index, body.label as string | undefined);
}

// Resolve the request to a server call. `step` is dispatched apart from the
// zero-arg lifecycle actions since it carries an index/label argument.
function resolveCall(body: { action?: unknown; step?: unknown; label?: unknown }, id: string, name: string) {
	if (body.action === 'step') return stepCall(body, id, name);
	const action = actionFor(body.action);
	if (!action) error(400, 'invalid action');
	return () => action(id, name);
}

export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json().catch(() => ({}));
	const call = resolveCall(body, params.id, params.name);
	try {
		return json(await call());
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to run action');
	}
};
