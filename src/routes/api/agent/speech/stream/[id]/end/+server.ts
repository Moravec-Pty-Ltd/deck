import type { RequestHandler } from './$types';
import { speechStreamEndRoute } from '$lib/server/speech-route';

// Same handler as the browser's POST /api/speech/stream/{id}/end; see speech-route.ts.
export const POST: RequestHandler = speechStreamEndRoute;
