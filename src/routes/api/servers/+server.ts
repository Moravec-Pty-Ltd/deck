import type { RequestHandler } from './$types';
import { serverStatesRoute } from '$lib/server/devservers-route';

// Per-session dev-server states, same handler as GET /api/agent/servers; see devservers-route.ts.
export const GET: RequestHandler = serverStatesRoute;
