import type { RequestHandler } from './$types';
import { deleteSecretRoute, putSecretRoute } from '$lib/server/remote-route';

export const PUT: RequestHandler = putSecretRoute;
export const DELETE: RequestHandler = deleteSecretRoute;
