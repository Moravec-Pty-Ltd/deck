import type { RequestHandler } from './$types';
import { changeSessionModel } from '$lib/server/session-model';

// Switch a session's model mid-session (issue #88), same handler as the
// browser's POST /api/sessions/[id]/model; see session-model.ts.
export const POST: RequestHandler = changeSessionModel;
