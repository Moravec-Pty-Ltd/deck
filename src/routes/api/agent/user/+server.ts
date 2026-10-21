import type { RequestHandler } from './$types';
import { currentUserRoute } from '$lib/server/pr';

// Same handler as the browser's GET /api/user; see pr.ts.
export const GET: RequestHandler = currentUserRoute;
