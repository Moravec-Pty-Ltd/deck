import type { RequestHandler } from './$types';
import { installSkillRoute, skillStatusRoute } from '$lib/server/settings';

export const GET: RequestHandler = skillStatusRoute;
export const POST: RequestHandler = installSkillRoute;
