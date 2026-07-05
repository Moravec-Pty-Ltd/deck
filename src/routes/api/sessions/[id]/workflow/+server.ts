import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { DeckSession, Workflow } from '$lib/types';
import { agentSessionOr404, objectBody } from '$lib/server/http';
import { agentTurnRunning } from '$lib/server/agents/dispatch';
import { cancelRun, runActive, startRun, workflowForPath } from '$lib/server/workflows';
import { contextFromSession } from '$lib/placeholders';

// Start or cancel a workflow run on an existing session (issue #111). The
// create-time path lives in POST /api/sessions; this covers "run workflow
// here" (e.g. finishing an existing worktree) and the progress strip's
// cancel/dismiss button.

// The requested workflow, resolved against the session's project. A
// custom-cwd session has no project, so only the synthesized pair resolves.
function workflowFor(session: DeckSession, workflowId: unknown): Workflow {
	if (typeof workflowId !== 'string' || !workflowId) error(400, 'workflowId required');
	const workflow = workflowForPath(session.cwd, workflowId);
	if (!workflow) error(400, 'unknown workflow');
	return workflow;
}

// Surface a start failure (cwd out of bounds, run already active) as a 400.
function start(session: DeckSession, workflow: Workflow): void {
	try {
		startRun(session, workflow, contextFromSession(session));
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to start workflow');
	}
}

export const POST: RequestHandler = async ({ params, request }) => {
	const session = await agentSessionOr404(params.id);
	const body = await objectBody(request);

	if (body.action === 'cancel') {
		cancelRun(session.id);
		return json({ ok: true });
	}

	if (runActive(session.id)) error(409, 'a workflow run is already active');
	// An in-flight turn would cross wires with the runner's turn tracking (its
	// idle would read as the first agent step finishing); require a quiet session.
	if (agentTurnRunning(session.id)) error(409, 'a turn is running; wait for it to finish');
	start(session, workflowFor(session, body.workflowId));
	return json({ ok: true, status: 'running' });
};
