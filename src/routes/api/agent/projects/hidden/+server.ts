import type { RequestHandler } from './$types';
import { setProjectHidden } from '$lib/server/project-hidden';

// Hide or unhide a project, same handler as the browser's
// POST /api/projects/hidden; see project-hidden.ts.
export const POST: RequestHandler = setProjectHidden;
