import type { RequestHandler } from './$types';
import { terminalSnapshotRoute } from '$lib/server/terminal';

// Same handler as the agent API's GET /api/agent/sessions/[id]/terminal; see terminal.ts.
export const GET: RequestHandler = terminalSnapshotRoute;
