import type { RequestHandler } from './$types';
import { folderStateRoute } from '$lib/server/project-record';

export const GET: RequestHandler = folderStateRoute;
