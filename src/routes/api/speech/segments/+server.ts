import type { RequestHandler } from './$types';
import { speechSegmentsRoute } from '$lib/server/speech-route';

// Reply text to playable segments, same handler as the agent API's twin; see speech-route.ts.
export const POST: RequestHandler = speechSegmentsRoute;
