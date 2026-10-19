import type { RequestHandler } from './$types';
import { pendingPairingsRoute } from '$lib/server/settings';

// Same handler as the browser's GET /api/pair/pending; see settings.ts.
export const GET: RequestHandler = pendingPairingsRoute;
