import type { RequestHandler } from './$types';
import { speechStreamOpenRoute } from '$lib/server/speech-route';

// Open a streaming take, same handler as the agent API's twin; see speech-route.ts.
export const POST: RequestHandler = speechStreamOpenRoute;
