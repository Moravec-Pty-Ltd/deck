import type { RequestHandler } from './$types';
import { currentUserRoute } from '$lib/server/pr';

export const GET: RequestHandler = currentUserRoute;
