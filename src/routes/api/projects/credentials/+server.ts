import type { RequestHandler } from './$types';
import { credentialsRoute } from '$lib/server/issue-source';

// GET ?type=linear: the saved issue-source keys a new source can reuse (issue
// #237), labels only. Same handler as the agent API's GET /api/agent/credentials;
// see issue-source.ts.
export const GET: RequestHandler = credentialsRoute;
