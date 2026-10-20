import type { RequestHandler } from './$types';
import { searchRoute } from '$lib/server/search';

// Same handler as the browser's GET /api/search; see search.ts.
export const GET: RequestHandler = searchRoute;
