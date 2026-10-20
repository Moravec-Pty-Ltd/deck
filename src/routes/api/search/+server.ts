import type { RequestHandler } from './$types';
import { searchRoute } from '$lib/server/search';

export const GET: RequestHandler = searchRoute;
