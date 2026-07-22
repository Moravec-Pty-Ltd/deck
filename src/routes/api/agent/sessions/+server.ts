import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSessions } from '$lib/server/sessions';
import { createSessionFromRequest, parsePr } from '$lib/server/create-session';
import { sessionDigest } from '$lib/server/agent-digest';
import { objectBody } from '$lib/server/http';
import { runIdempotent } from '$lib/server/idempotency';
import { baseUrl } from '$lib/server/config';
import { listProjects } from '$lib/server/store';
import { projectForPath } from '$lib/server/confine';
import { expandTilde } from '$lib/server/fsutil';
import type { Project } from '$lib/types';

// Agent-facing sessions surface (issue #127): a stable, documented contract
// (see /llms.txt) over the internal create/list primitives. Digests aggregate
// everything a monitor needs (status, awaitingInput, cost, pr) in one payload
// instead of per-session SSE snapshots.

export const GET: RequestHandler = async () => {
	return json((await listSessions()).map((s) => sessionDigest(s)));
};

// Fields shared by both modes, passed through to the create pipeline (which
// validates them; kind defaults to claude for the common orchestrator case).
// Shells are rejected: the agent API has no way to drive one (message/stop/
// answer are agent-session endpoints), so creating one here would be a
// session the contract can't control.
function commonFields(body: Record<string, unknown>): Record<string, unknown> {
	const { cwd, prompt, kind, title, model, provider, effort, permissionMode } = body;
	if (kind === 'shell') error(400, 'the agent API drives agent sessions, not shells');
	return { cwd, prompt, kind: kind ?? 'claude', title, model, provider, effort, permissionMode };
}

// Reject an invalid pr up front with the create pipeline's own parser: it
// would otherwise be dropped silently, yielding a session whose review/merge
// endpoints can never work.
function requiredPr(v: unknown): Record<string, unknown> {
	if (!parsePr(v)) error(400, 'review mode requires a valid pr { repo: "owner/repo", number }');
	return v as Record<string, unknown>;
}

// A supplied prompt always wins; only a blank/missing one gets the project
// default filled in below.
function hasPrompt(body: Record<string, unknown>): boolean {
	return typeof body.prompt === 'string' && body.prompt.trim().length > 0;
}

// The registered project a raw (untyped) cwd belongs to, or undefined.
function projectForCwd(cwd: unknown): Project | undefined {
	if (typeof cwd !== 'string' || !cwd) return undefined;
	const path = projectForPath(expandTilde(cwd));
	return listProjects().find((p) => p.path === path);
}

// Trimmed, or undefined for a blank/absent value.
function nonEmpty(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

// The web new-session modal prefills the project's template/reviewPrompt into
// the prompt field before posting (issue #127's agent API otherwise leaves a
// prompt-less session idle forever, since maybeDispatch no-ops without one).
// This mirrors that default for clients that can't prefill client-side (the
// watch/iOS quick-start, Siri intents): resolve `cwd` back to its registered
// project and use its configured first-prompt for the mode, if any.
function defaultPrompt(cwd: unknown, review: boolean): string | undefined {
	const project = projectForCwd(cwd);
	return nonEmpty(review ? project?.reviewPrompt : project?.template);
}

// 'review': check out the PR's head into a worktree and seed the session with
// the PR, so the review/merge endpoints work on it.
function reviewBody(body: Record<string, unknown>): Record<string, unknown> {
	const pr = requiredPr(body.pr);
	const wt = (body.worktree ?? {}) as Record<string, unknown>;
	const fields = commonFields(body);
	if (!hasPrompt(body)) fields.prompt = defaultPrompt(body.cwd, true);
	return { ...fields, pr, worktree: { fromPr: pr.number, base: wt.base } };
}

// 'work': start a session on an issue/prompt, optionally in a fresh worktree.
function workBody(body: Record<string, unknown>): Record<string, unknown> {
	const issues = body.issue ? [body.issue] : undefined;
	const fields = commonFields(body);
	if (!hasPrompt(body)) fields.prompt = defaultPrompt(body.cwd, false);
	return { ...fields, issues, worktree: body.worktree };
}

function internalBody(body: Record<string, unknown>): Record<string, unknown> {
	if (body.mode === 'review') return reviewBody(body);
	if (body.mode === 'work') return workBody(body);
	error(400, "mode must be 'work' or 'review'");
}

// An idempotency key (header `Idempotency-Key`, or body `idempotencyKey`) dedupes
// a retried create so a lost 201 response can't spawn a second session + worktree.
// Bounded so a junk header can't bloat the in-memory map; empty means none.
function bodyKey(body: Record<string, unknown>): string {
	return typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
}
function idempotencyKey(headers: Headers, body: Record<string, unknown>): string | null {
	const key = (headers.get('idempotency-key') || bodyKey(body)).trim();
	return key && key.length <= 200 ? key : null;
}

// { mode: 'work' | 'review', cwd, ... } -> { id, url }. Both modes map onto
// the shared create pipeline, so validation and side effects match the UI path.
// A replayed idempotency key returns the original result with 200 instead of 201.
export const POST: RequestHandler = async ({ request }) => {
	const body = await objectBody(request);
	// Validate before the idempotent run so a malformed body 400s without caching.
	const internal = internalBody(body);
	const { replay, result } = runIdempotent(idempotencyKey(request.headers, body), async () => {
		const session = await createSessionFromRequest(internal);
		return { id: session.id, url: `${baseUrl}/s/${session.id}` };
	});
	return json(await result, { status: replay ? 200 : 201 });
};
