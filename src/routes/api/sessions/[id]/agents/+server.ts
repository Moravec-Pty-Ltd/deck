import type { RequestHandler } from './$types';
import { sessionAgentsRoute } from '$lib/server/session-stream';

// Same handler as the agent API's GET /api/agent/sessions/[id]/agents; see session-stream.ts.
export const GET: RequestHandler = sessionAgentsRoute;
