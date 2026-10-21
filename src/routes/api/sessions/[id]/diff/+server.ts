import type { RequestHandler } from './$types';
import { sessionDiffRoute } from '$lib/server/session-reads';

// The Changes tab, same handler as the agent API's GET /api/agent/sessions/[id]/diff; see session-reads.ts.
export const GET: RequestHandler = sessionDiffRoute;
