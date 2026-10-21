import type { RequestHandler } from './$types';
import { quickMessagesGetRoute, quickMessagesPutRoute } from '$lib/server/quickmessages';

// Same handlers as the browser's /api/quick-messages; see quickmessages.ts.
export const GET: RequestHandler = quickMessagesGetRoute;
export const PUT: RequestHandler = quickMessagesPutRoute;
