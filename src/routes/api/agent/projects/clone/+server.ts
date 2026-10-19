import type { RequestHandler } from './$types';
import { cloneProjectRoute } from '$lib/server/project-clone';

// Same handler as the browser's /api/projects/clone; see project-clone.ts.
export const POST: RequestHandler = cloneProjectRoute;
