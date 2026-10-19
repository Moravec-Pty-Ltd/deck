import type { RequestHandler } from './$types';
import { operatorHistoryRoute } from '$lib/server/operator-route';

// The recent operator conversation, same handler as the agent API's twin; see operator-route.ts.
export const GET: RequestHandler = operatorHistoryRoute;
