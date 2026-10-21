import type { RequestHandler } from './$types';
import { agentSettingsRoute, patchSettingsRoute } from '$lib/server/settings';

export const GET: RequestHandler = agentSettingsRoute;
export const PATCH: RequestHandler = patchSettingsRoute;
