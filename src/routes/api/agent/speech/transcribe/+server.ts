import type { RequestHandler } from './$types';
import { speechTranscribeRoute } from '$lib/server/speech-route';

// Same handler as the browser's POST /api/speech/transcribe; see speech-route.ts.
export const POST: RequestHandler = speechTranscribeRoute;
