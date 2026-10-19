import type { RequestHandler } from './$types';
import { operatorResetRoute } from '$lib/server/operator-route';

// Start a new operator conversation, same handler as the agent API's twin; see operator-route.ts.
export const POST: RequestHandler = operatorResetRoute;
