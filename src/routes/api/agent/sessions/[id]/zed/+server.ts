import type { RequestHandler } from './$types';
import { zedCommandRoute } from '$lib/server/zed';

// Same handler as the browser's GET /api/sessions/[id]/zed; see zed.ts.
export const GET: RequestHandler = zedCommandRoute;
