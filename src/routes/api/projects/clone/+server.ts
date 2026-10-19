import type { RequestHandler } from './$types';
import { cloneProjectRoute } from '$lib/server/project-clone';

// Same handler as the agent API's /api/agent/projects/clone; see project-clone.ts.
export const POST: RequestHandler = cloneProjectRoute;
