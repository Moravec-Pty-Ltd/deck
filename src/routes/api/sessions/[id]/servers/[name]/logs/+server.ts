import type { RequestHandler } from './$types';
import { serverLogsRoute } from '$lib/server/devservers-route';

// Live log pane for a dev server, same handler as the agent API's twin; see devservers-route.ts.
export const GET: RequestHandler = serverLogsRoute;
