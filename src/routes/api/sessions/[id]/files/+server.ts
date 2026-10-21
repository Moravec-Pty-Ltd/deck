import type { RequestHandler } from './$types';
import { serveFileRoute, statFilesRoute } from '$lib/server/session-reads';

// Same handlers as the agent API's /api/agent/sessions/[id]/files; see session-reads.ts.
export const POST: RequestHandler = statFilesRoute;
export const GET: RequestHandler = serveFileRoute;
