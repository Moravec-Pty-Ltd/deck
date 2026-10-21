import type { RequestHandler } from './$types';
import { speechInfoRoute } from '$lib/server/speech-route';

// What voice mode can do here, same handler as GET /api/agent/speech; see speech-route.ts.
export const GET: RequestHandler = speechInfoRoute;
