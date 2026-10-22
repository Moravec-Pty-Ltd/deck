import type { RequestHandler } from './$types';
import { speechStreamChunkRoute } from '$lib/server/speech-route';

// A chunk of a streaming take, same handler as the agent API's twin; see speech-route.ts.
export const POST: RequestHandler = speechStreamChunkRoute;
