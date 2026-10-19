import type { RequestHandler } from './$types';
import { addSourceRoute, removeSourceRoute } from '$lib/server/issue-source';

// Add (POST) or remove (DELETE ?project=&id=) a project's issue source, same
// handlers as the agent API's /api/agent/projects/sources; see issue-source.ts.
export const POST: RequestHandler = addSourceRoute;
export const DELETE: RequestHandler = removeSourceRoute;
