import type { RequestHandler } from './$types';
import { operatorResetRoute } from '$lib/server/operator-route';

// Same handler as the browser's POST /api/operator/reset; see operator-route.ts.
export const POST: RequestHandler = operatorResetRoute;
