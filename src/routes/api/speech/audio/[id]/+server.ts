import type { RequestHandler } from './$types';
import { speechAudioRoute } from '$lib/server/speech-route';

// One segment's audio, same handler as the agent API's twin; see speech-route.ts.
export const GET: RequestHandler = speechAudioRoute;
