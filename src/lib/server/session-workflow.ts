import { json, error } from '@sveltejs/kit';
import type { DeckSession, Workflow } from '$lib/types';
import { agentSessionOr404, objectBody } from './http';
import { agentTurnRunning } from './agents/dispatch';
import { cancelRun, runActive, startRun, workflowForPath } from './workflows';
import { contextFromSession } from '$lib/placeholders';

// Start or cancel a workflow run on an existing session (issue #111), shared by
// the internal POST /api/sessions/[id]/workflow and its agent-namespace mirror
// POST /api/agent/sessions/[id]/workflow (issue #144). The create-time path lives
// in POST /api/sessions; this covers "run workflow here" (e.g. finishing an
// existing worktree) and the progress strip's cancel/dismiss button — so an
// orchestrator that attached a workflow at create can also cancel it.

// The requested workflow, resolved against the session's project. The legacy
// synthesized pair never resolves (see workflowForPath), so a crafted request
// can't attach run state to the plain new-session path.
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

// { action: 'cancel' } cancels/dismisses the run; otherwise { workflowId } starts
// one. 409 when a run or turn is already in flight (an in-flight turn would cross
// wires with the runner's turn tracking).
export async function sessionWorkflowRoute(event: {
	params: Partial<Record<string, string>>;
	request: Request;
}): Promise<Response> {
	const session = await agentSessionOr404(event.params.id!);
	const body = await objectBody(event.request);

	if (body.action === 'cancel') {
		cancelRun(session.id);
		return json({ ok: true });
	}

	if (runActive(session.id)) error(409, 'a workflow run is already active');
	if (agentTurnRunning(session.id)) error(409, 'a turn is running; wait for it to finish');
	start(session, workflowFor(session, body.workflowId));
	return json({ ok: true, status: 'running' });
}
