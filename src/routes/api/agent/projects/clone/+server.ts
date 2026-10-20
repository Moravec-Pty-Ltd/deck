import type { RequestHandler } from './$types';
import { cloneProjectRoute } from '$lib/server/project-clone';

export const POST: RequestHandler = cloneProjectRoute;
