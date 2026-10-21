import type { RequestHandler } from './$types';
import { sessionDirRoute } from '$lib/server/session-reads';

// Same handler as the browser's /api/sessions/[id]/dir; see session-reads.ts.
export const GET: RequestHandler = sessionDirRoute;
