import type { RequestHandler } from './$types';
import { speechInfoRoute } from '$lib/server/speech-route';

// Same handler as the browser's GET /api/speech; see speech-route.ts.
export const GET: RequestHandler = speechInfoRoute;
