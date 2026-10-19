import type { RequestHandler } from './$types';
import { zedCommandRoute } from '$lib/server/zed';

export const GET: RequestHandler = zedCommandRoute;
