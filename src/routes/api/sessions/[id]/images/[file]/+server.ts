import type { RequestHandler } from './$types';
import { sessionImageRoute } from '$lib/server/session-reads';

// Same handler as the agent API's GET /api/agent/sessions/[id]/images/[file]; see session-reads.ts.
export const GET: RequestHandler = sessionImageRoute;
