import type { RequestHandler } from './$types';
import { transcriptRangeRoute } from '$lib/server/session-reads';

// Older history for back-scroll, same handler as the agent API's GET /api/agent/sessions/[id]/history; see session-reads.ts.
export const GET: RequestHandler = transcriptRangeRoute;
