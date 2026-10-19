import type { RequestHandler } from './$types';
import { installSkillRoute, skillStatusRoute } from '$lib/server/settings';

// Same handlers as the browser's /api/skills; see settings.ts.
export const GET: RequestHandler = skillStatusRoute;
export const POST: RequestHandler = installSkillRoute;
