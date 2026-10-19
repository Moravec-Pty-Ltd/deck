import type { RequestHandler } from './$types';
import { serverLogsRoute } from '$lib/server/devservers-route';

// Same handler as the browser's GET /api/sessions/[id]/servers/[name]/logs; see devservers-route.ts.
export const GET: RequestHandler = serverLogsRoute;
