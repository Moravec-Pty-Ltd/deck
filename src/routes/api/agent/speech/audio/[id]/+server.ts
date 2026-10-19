import type { RequestHandler } from './$types';
import { speechAudioRoute } from '$lib/server/speech-route';

// Same handler as the browser's GET /api/speech/audio/[id]; see speech-route.ts.
export const GET: RequestHandler = speechAudioRoute;
