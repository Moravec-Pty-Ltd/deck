import type { RequestHandler } from './$types';
import { operatorChatRoute, operatorInfoRoute } from '$lib/server/operator-route';

// Same handlers as the browser's /api/operator; see operator-route.ts.
export const GET: RequestHandler = operatorInfoRoute;
export const POST: RequestHandler = operatorChatRoute;
