import type { RequestHandler } from './$types';
import { speechDetectRoute } from '$lib/server/settings';

// Same handler as the agent API's POST /api/agent/settings/speech/detect; see settings.ts.
export const POST: RequestHandler = speechDetectRoute;
