import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listProjects } from '$lib/server/store';
import { registerProjectRoute, removeProjectRoute } from '$lib/server/project-record';

export const GET: RequestHandler = () => json(listProjects());

// Same handlers as the agent API's /api/agent/projects; see project-record.ts.
export const POST: RequestHandler = registerProjectRoute;
export const DELETE: RequestHandler = removeProjectRoute;
