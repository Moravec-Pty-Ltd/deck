import type { RequestHandler } from './$types';
import { operatorEventsRoute } from '$lib/server/operator-route';

// Same handler as the browser's GET /api/operator/events; see operator-route.ts.
export const GET: RequestHandler = operatorEventsRoute;
