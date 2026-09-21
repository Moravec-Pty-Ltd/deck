import type { RequestHandler } from './$types';
import { restartSession } from '$lib/server/session-restart';

// Same handler as the browser's POST /api/sessions/[id]/restart; see session-restart.ts.
export const POST: RequestHandler = restartSession;
