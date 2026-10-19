import type { RequestHandler } from './$types';
import { sessionServersRoute } from '$lib/server/devservers-route';

// Same handler as the browser's GET /api/sessions/[id]/servers; see devservers-route.ts.
export const GET: RequestHandler = sessionServersRoute;
