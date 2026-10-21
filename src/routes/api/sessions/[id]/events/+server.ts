import type { RequestHandler } from './$types';
import { sessionStreamRoute } from '$lib/server/session-stream';

// SSE transcript stream, same handler as the agent API's GET /api/agent/sessions/[id]/stream; see session-stream.ts.
export const GET: RequestHandler = sessionStreamRoute;
