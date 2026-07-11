import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStoredSession } from '$lib/server/store';
import { objectBody, prActionResponse } from '$lib/server/http';
import { mergePr, MERGE_FLAG, type MergeMethod } from '$lib/server/pr';

// `method` defaults to squash (the common orchestrator case); an unknown
// method is a 400, not a fallback. Own-property guard as in the review route.
function mergeMethod(v: unknown): MergeMethod {
	const method = v ?? 'squash';
	if (typeof method === 'string' && Object.hasOwn(MERGE_FLAG, method)) return method as MergeMethod;
	error(400, 'invalid merge method');
}

// Merge the session's captured PR (repo + number resolved from the stored
// session, never the request).
export const POST: RequestHandler = async ({ params, request }) => {
	if (!getStoredSession(params.id)) error(404, 'session not found');
	const b = await objectBody(request);
	const method = mergeMethod(b.method);
	return prActionResponse(() => mergePr(params.id, method, b.deleteBranch === true));
};
