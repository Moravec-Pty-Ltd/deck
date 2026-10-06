import type { RequestHandler } from './$types';
import { uploadToSession } from '$lib/server/session-upload';

// Share files with a session, same handler as the browser's
// POST /api/sessions/[id]/upload; see session-upload.ts.
export const POST: RequestHandler = uploadToSession;
