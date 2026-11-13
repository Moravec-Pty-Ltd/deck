import type { RequestHandler } from './$types';
import { acceptHostKeyRoute, scanHostKeyRoute } from '$lib/server/remote-route';

export const GET: RequestHandler = scanHostKeyRoute;
export const POST: RequestHandler = acceptHostKeyRoute;
