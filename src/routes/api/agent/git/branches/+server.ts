import type { RequestHandler } from './$types';
import { branchesRoute } from '$lib/server/project-git';

// Same handler as the browser's /api/git/branches; see project-git.ts.
export const GET: RequestHandler = branchesRoute;
