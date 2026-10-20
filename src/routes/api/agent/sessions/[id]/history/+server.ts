import type { RequestHandler } from './$types';
import { transcriptRangeRoute } from '$lib/server/session-reads';

// Same handler as the browser's GET /api/sessions/[id]/transcript; see session-reads.ts.
export const GET: RequestHandler = transcriptRangeRoute;
