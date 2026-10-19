import type { RequestHandler } from './$types';
import { installSkillRoute, skillStatusRoute } from '$lib/server/settings';

// The projects page's Agent skills panel, same handlers as the agent API's
// /api/agent/settings/skill; see settings.ts.
export const GET: RequestHandler = skillStatusRoute;
export const POST: RequestHandler = installSkillRoute;
