import type { RequestHandler } from './$types';
import { sessionStreamRoute } from '$lib/server/session-stream';

// Same handler as the browser's GET /api/sessions/[id]/events; see session-stream.ts.
export const GET: RequestHandler = sessionStreamRoute;
