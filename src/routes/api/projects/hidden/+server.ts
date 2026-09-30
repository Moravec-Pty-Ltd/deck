import type { RequestHandler } from './$types';
import { setProjectHidden } from '$lib/server/project-hidden';

// Hide or unhide a project, same handler as the agent API's
// POST /api/agent/projects/hidden; see project-hidden.ts.
export const POST: RequestHandler = setProjectHidden;
