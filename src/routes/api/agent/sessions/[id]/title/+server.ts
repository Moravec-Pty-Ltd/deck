import type { RequestHandler } from './$types';
import { renameSession } from '$lib/server/session-title';

// Rename a session, same handler as the browser's POST /api/sessions/[id]/title;
// see session-title.ts.
export const POST: RequestHandler = renameSession;
