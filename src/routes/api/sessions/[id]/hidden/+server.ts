import type { RequestHandler } from './$types';
import { setHidden } from '$lib/server/session-hidden';

// Hide or unhide a session, same handler as the agent API's
// POST /api/agent/sessions/[id]/hidden; see session-hidden.ts.
export const POST: RequestHandler = setHidden;
