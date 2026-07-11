import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStoredSession } from '$lib/server/store';
import { objectBody, prActionResponse } from '$lib/server/http';
import { reviewPr, REVIEW_FLAG, type ReviewDecision } from '$lib/server/pr';

// Own-property guard so an inherited key can't slip into a gh flag.
function reviewDecision(v: unknown): ReviewDecision {
	if (typeof v === 'string' && Object.hasOwn(REVIEW_FLAG, v)) return v as ReviewDecision;
	error(400, 'invalid review decision');
}

// A body is required except for a bare approve (gh rejects an empty one),
// mirroring the internal /pr route.
function reviewArgs(b: Record<string, unknown>): { decision: ReviewDecision; body: string } {
	const decision = reviewDecision(b.decision);
	const body = typeof b.body === 'string' ? b.body : '';
	if (decision !== 'approve' && !body.trim()) error(400, 'a review message is required');
	return { decision, body };
}

// Submit a review on the session's captured PR. The PR's repo + number come
// from the stored session, never the request, so this can only touch this
// session's own PR.
export const POST: RequestHandler = async ({ params, request }) => {
	if (!getStoredSession(params.id)) error(404, 'session not found');
	const { decision, body } = reviewArgs(await objectBody(request));
	return prActionResponse(() => reviewPr(params.id, decision, body));
};
