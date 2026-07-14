import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listProjects } from '$lib/server/store';
import { projectDigest } from '$lib/server/agent-digest';

// Stable { path, name, group } projection of the registered projects (issue
// #144), so an orchestrator can discover a valid `cwd` for create without
// coupling to the full stored Project (dev config, sources).
export const GET: RequestHandler = () => json(listProjects().map(projectDigest));
