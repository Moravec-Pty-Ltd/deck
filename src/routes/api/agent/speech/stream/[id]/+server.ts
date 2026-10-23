import type { RequestHandler } from './$types';
import { speechStreamChunkRoute } from '$lib/server/speech-route';

// Same handler as the browser's POST /api/speech/stream/{id}; see speech-route.ts.
export const POST: RequestHandler = speechStreamChunkRoute;
