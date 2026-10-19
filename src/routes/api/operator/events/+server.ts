import type { RequestHandler } from './$types';
import { operatorEventsRoute } from '$lib/server/operator-route';

// The operator's announcement stream, same handler as the agent API's twin; see operator-route.ts.
export const GET: RequestHandler = operatorEventsRoute;
