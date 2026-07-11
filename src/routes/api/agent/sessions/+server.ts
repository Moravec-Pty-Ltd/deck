import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSessions } from '$lib/server/sessions';
import { createSessionFromRequest, parsePr } from '$lib/server/create-session';
import { sessionDigest } from '$lib/server/agent-digest';
import { objectBody } from '$lib/server/http';
import { baseUrl } from '$lib/server/config';

// Agent-facing sessions surface (issue #127): a stable, documented contract
// (see /llms.txt) over the internal create/list primitives. Digests aggregate
// everything a monitor needs (status, awaitingInput, workflowRun, cost, pr) in
// one payload instead of per-session SSE snapshots.

export const GET: RequestHandler = async () => {
	return json((await listSessions()).map(sessionDigest));
};

// Fields shared by both modes, passed through to the create pipeline (which
// validates them; kind defaults to claude for the common orchestrator case).
function commonFields(body: Record<string, unknown>): Record<string, unknown> {
	const { cwd, prompt, kind, workflowId, title, model, provider, permissionMode } = body;
	return { cwd, prompt, kind: kind ?? 'claude', workflowId, title, model, provider, permissionMode };
}

// Reject an invalid pr up front with the create pipeline's own parser: it
// would otherwise be dropped silently, yielding a session whose review/merge
// endpoints can never work.
function requiredPr(v: unknown): Record<string, unknown> {
	if (!parsePr(v)) error(400, 'review mode requires a valid pr { repo: "owner/repo", number }');
	return v as Record<string, unknown>;
}

// 'review': check out the PR's head into a worktree and seed the session with
// the PR, so the review/merge endpoints work on it.
function reviewBody(body: Record<string, unknown>): Record<string, unknown> {
	const pr = requiredPr(body.pr);
	const wt = (body.worktree ?? {}) as Record<string, unknown>;
	return { ...commonFields(body), pr, worktree: { fromPr: pr.number, base: wt.base } };
}

// 'work': start a session on an issue/prompt, optionally in a fresh worktree.
function workBody(body: Record<string, unknown>): Record<string, unknown> {
	const issues = body.issue ? [body.issue] : undefined;
	return { ...commonFields(body), issues, worktree: body.worktree };
}

function internalBody(body: Record<string, unknown>): Record<string, unknown> {
	if (body.mode === 'review') return reviewBody(body);
	if (body.mode === 'work') return workBody(body);
	error(400, "mode must be 'work' or 'review'");
}

// { mode: 'work' | 'review', cwd, ... } -> { id, url }. Both modes map onto
// the shared create pipeline, so validation and side effects match the UI path.
export const POST: RequestHandler = async ({ request }) => {
	const internal = internalBody(await objectBody(request));
	const session = await createSessionFromRequest(internal);
	return json({ id: session.id, url: `${baseUrl}/s/${session.id}` }, { status: 201 });
};
