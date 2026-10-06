import type { RequestHandler } from './$types';
import { uploadToSession } from '$lib/server/session-upload';

// Share files with a session, same handler as the agent API's
// POST /api/agent/sessions/[id]/upload; see session-upload.ts.
export const POST: RequestHandler = uploadToSession;
