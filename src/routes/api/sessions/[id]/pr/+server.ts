import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStoredSession, updateSession } from '$lib/server/store';
import {
	reviewPr,
	mergePr,
	refreshPr,
	REVIEW_FLAG,
	MERGE_FLAG,
	type ReviewDecision,
	type MergeMethod
} from '$lib/server/pr';

// Actions on a session's captured PR. Status itself is kept fresh by the
// background bulk sync (server/pr.ts), so there's no on-open GET: review / merge
// run a `gh` command and return the freshly re-synced PR, and refresh just
// re-syncs. The PR's repo + number are always resolved from the stored session,
// never from the request, so an action can only ever touch this session's own PR.
type Body = {
	action?: unknown;
	decision?: unknown;
	method?: unknown;
	body?: unknown;
	deleteBranch?: unknown;
};

// Own-property guards (REVIEW_FLAG/MERGE_FLAG as the allowlist) so an inherited
// key from untrusted input can't slip through into a gh flag.
function reviewDecision(v: unknown): ReviewDecision {
	if (typeof v === 'string' && Object.hasOwn(REVIEW_FLAG, v)) return v as ReviewDecision;
	error(400, 'invalid review decision');
}

function mergeMethod(v: unknown): MergeMethod {
	if (typeof v === 'string' && Object.hasOwn(MERGE_FLAG, v)) return v as MergeMethod;
	error(400, 'invalid merge method');
}

// A body is required for request-changes / comment (gh rejects an empty one); a
// bare approve may omit it.
function reviewCall(id: string, b: Body) {
	const decision = reviewDecision(b.decision);
	const body = typeof b.body === 'string' ? b.body : '';
	if (decision !== 'approve' && !body.trim()) error(400, 'a review message is required');
	return () => reviewPr(id, decision, body);
}

function mergeCall(id: string, b: Body) {
	const method = mergeMethod(b.method);
	return () => mergePr(id, method, b.deleteBranch === true);
}

function resolveCall(id: string, b: Body) {
	if (b.action === 'review') return reviewCall(id, b);
	if (b.action === 'merge') return mergeCall(id, b);
	if (b.action === 'refresh') return () => refreshPr(id);
	error(400, 'invalid action');
}

// gh surfaces a real failure (own-PR approve, dirty merge) as a thrown error; turn
// it into a 400 carrying gh's message so the menu can show it inline.
async function runCall(call: () => Promise<unknown>) {
	try {
		return json({ pr: (await call()) ?? null });
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to run PR action');
	}
}

export const POST: RequestHandler = async ({ params, request }) => {
	if (!getStoredSession(params.id)) error(404, 'session not found');
	const body = (await request.json().catch(() => ({}))) as Body;
	return runCall(resolveCall(params.id, body));
};

// Dismiss the captured PR chip. Capture is forward-only, so the next GitHub PR
// link an agent prints repopulates it; the one-time backfill won't bring the
// dismissed link back because its scan marker (prBackfilled) is already set.
export const DELETE: RequestHandler = async ({ params }) => {
	if (!getStoredSession(params.id)) error(404, 'session not found');
	updateSession(params.id, { pr: undefined });
	return json({ ok: true });
};
