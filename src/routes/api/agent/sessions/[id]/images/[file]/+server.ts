import type { RequestHandler } from './$types';
import { sessionImageRoute } from '$lib/server/session-reads';

// Same handler as the browser's GET /api/sessions/[id]/images/[file]; see session-reads.ts.
export const GET: RequestHandler = sessionImageRoute;
