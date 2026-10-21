import type { RequestHandler } from './$types';
import { worktreesRoute } from '$lib/server/project-git';

// Same handler as the agent API's /api/agent/git/worktrees; see project-git.ts.
export const GET: RequestHandler = worktreesRoute;
