import type { RequestHandler } from './$types';
import { operatorChatRoute, operatorInfoRoute } from '$lib/server/operator-route';

// The voice operator, same handlers as /api/agent/operator; see operator-route.ts.
export const GET: RequestHandler = operatorInfoRoute;
export const POST: RequestHandler = operatorChatRoute;
