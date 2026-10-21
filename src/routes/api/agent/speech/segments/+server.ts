import type { RequestHandler } from './$types';
import { speechSegmentsRoute } from '$lib/server/speech-route';

// Same handler as the browser's POST /api/speech/segments; see speech-route.ts.
export const POST: RequestHandler = speechSegmentsRoute;
