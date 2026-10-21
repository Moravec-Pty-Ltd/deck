import type { RequestHandler } from './$types';
import { operatorHistoryRoute } from '$lib/server/operator-route';

// Same handler as the browser's GET /api/operator/history; see operator-route.ts.
export const GET: RequestHandler = operatorHistoryRoute;
