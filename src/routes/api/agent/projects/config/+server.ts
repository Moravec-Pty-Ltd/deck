import type { RequestHandler } from './$types';
import { patchProjectConfigRoute, projectConfigRoute } from '$lib/server/project-record';

export const GET: RequestHandler = projectConfigRoute;
export const PATCH: RequestHandler = patchProjectConfigRoute;
