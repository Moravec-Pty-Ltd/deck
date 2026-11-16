import type { RequestHandler } from './$types';
import { remoteStatusRoute } from '$lib/server/remote-route';

export const GET: RequestHandler = remoteStatusRoute;
