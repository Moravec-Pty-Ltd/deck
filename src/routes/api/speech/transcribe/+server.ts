import type { RequestHandler } from './$types';
import { speechTranscribeRoute } from '$lib/server/speech-route';

// Push-to-talk audio to text, same handler as the agent API's twin; see speech-route.ts.
export const POST: RequestHandler = speechTranscribeRoute;
