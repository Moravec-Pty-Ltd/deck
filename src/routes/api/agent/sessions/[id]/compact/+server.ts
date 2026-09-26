import type { RequestHandler } from './$types';
import { compactSessionRoute } from '$lib/server/session-compact';

// Compact a session's context, same handler as the browser's
// POST /api/sessions/[id]/compact; see session-compact.ts.
export const POST: RequestHandler = compactSessionRoute;
