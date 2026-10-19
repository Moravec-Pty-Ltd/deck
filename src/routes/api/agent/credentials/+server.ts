import type { RequestHandler } from './$types';
import { credentialsRoute } from '$lib/server/issue-source';

// The saved issue-source keys, labels only; see issue-source.ts.
export const GET: RequestHandler = credentialsRoute;
