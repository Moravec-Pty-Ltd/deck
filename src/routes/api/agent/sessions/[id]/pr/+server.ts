import type { RequestHandler } from './$types';
import { dismissPrRoute } from '$lib/server/pr';

export const DELETE: RequestHandler = dismissPrRoute;
