import type { RequestHandler } from './$types';
import { speechStreamOpenRoute } from '$lib/server/speech-route';

// Same handler as the browser's POST /api/speech/stream; see speech-route.ts.
export const POST: RequestHandler = speechStreamOpenRoute;
