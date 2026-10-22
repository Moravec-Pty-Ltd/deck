import type { RequestHandler } from './$types';
import { speechStreamEndRoute } from '$lib/server/speech-route';

// End a streaming take, same handler as the agent API's twin; see speech-route.ts.
export const POST: RequestHandler = speechStreamEndRoute;
