import type { RequestHandler } from './$types';
import { sessionAgentsRoute } from '$lib/server/session-stream';

// Same handler as the browser's GET /api/sessions/[id]/agents; see session-stream.ts.
export const GET: RequestHandler = sessionAgentsRoute;
