import type { RequestHandler } from './$types';
import { restartSession } from '$lib/server/session-restart';

// Same handler as the agent API's POST /api/agent/sessions/[id]/restart; see session-restart.ts.
export const POST: RequestHandler = restartSession;
