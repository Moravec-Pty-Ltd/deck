import type { RequestHandler } from './$types';
import { changeSessionEffort } from '$lib/server/session-effort';

// Switch a session's reasoning effort mid-session (issue #178), same handler as
// the browser's POST /api/sessions/[id]/effort; see session-effort.ts.
export const POST: RequestHandler = changeSessionEffort;
