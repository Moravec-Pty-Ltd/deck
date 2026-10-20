import type { RequestHandler } from './$types';
import { speechDetectRoute } from '$lib/server/settings';

export const POST: RequestHandler = speechDetectRoute;
