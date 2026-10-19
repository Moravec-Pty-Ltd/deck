import type { RequestHandler } from './$types';
import { speechDetectRoute } from '$lib/server/settings';

// Same handler as the browser's POST /api/speech/detect; see settings.ts.
export const POST: RequestHandler = speechDetectRoute;
