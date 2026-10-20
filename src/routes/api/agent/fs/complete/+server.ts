import type { RequestHandler } from './$types';
import { completeDirsRoute } from '$lib/server/project-record';

export const GET: RequestHandler = completeDirsRoute;
