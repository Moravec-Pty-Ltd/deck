import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listProjects } from '$lib/server/store';
import { projectDigest } from '$lib/server/agent-digest';
import { registerProjectRoute, removeProjectRoute } from '$lib/server/project-record';

// Stable { path, name, group } projection of the registered projects (issue
// #144), so an orchestrator can discover a valid `cwd` for create without
// coupling to the full stored Project (dev config, sources).
export const GET: RequestHandler = () => json(listProjects().map(projectDigest));

// Same handlers as the browser's /api/projects; see project-record.ts.
export const POST: RequestHandler = registerProjectRoute;
export const DELETE: RequestHandler = removeProjectRoute;
