import type { RequestHandler } from './$types';
import { serverActionRoute } from '$lib/server/devservers-route';

// Same handler as the browser's POST /api/sessions/[id]/servers/[name]; see devservers-route.ts.
export const POST: RequestHandler = serverActionRoute;
