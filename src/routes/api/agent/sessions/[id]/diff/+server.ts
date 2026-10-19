import type { RequestHandler } from './$types';
import { sessionDiffRoute } from '$lib/server/session-reads';

// Same handler as the browser's GET /api/sessions/[id]/diff; see session-reads.ts.
export const GET: RequestHandler = sessionDiffRoute;
