import type { RequestHandler } from './$types';
import { dismissPrRoute } from '$lib/server/pr';

// Same handler as the browser's DELETE /api/sessions/[id]/pr; see pr.ts.
export const DELETE: RequestHandler = dismissPrRoute;
