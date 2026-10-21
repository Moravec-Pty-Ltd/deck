import type { RequestHandler } from './$types';
import { sessionServersRoute } from '$lib/server/devservers-route';

// Configured dev servers for the session (issue #32), same handler as the agent API's twin; see devservers-route.ts.
export const GET: RequestHandler = sessionServersRoute;
