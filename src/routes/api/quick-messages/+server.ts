import type { RequestHandler } from './$types';
import { quickMessagesGetRoute, quickMessagesPutRoute } from '$lib/server/quickmessages';

export const GET: RequestHandler = quickMessagesGetRoute;
export const PUT: RequestHandler = quickMessagesPutRoute;
