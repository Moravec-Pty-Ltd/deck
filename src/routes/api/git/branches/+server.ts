import type { RequestHandler } from './$types';
import { branchesRoute } from '$lib/server/project-git';

// Same handler as the agent API's /api/agent/git/branches; see project-git.ts.
export const GET: RequestHandler = branchesRoute;
