import type { RequestHandler } from './$types';
import { serverStatesRoute } from '$lib/server/devservers-route';

// Same handler as the browser's GET /api/servers; see devservers-route.ts.
export const GET: RequestHandler = serverStatesRoute;
