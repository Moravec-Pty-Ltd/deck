import type { RequestHandler } from './$types';
import { pendingPairingsRoute } from '$lib/server/settings';

export const GET: RequestHandler = pendingPairingsRoute;
