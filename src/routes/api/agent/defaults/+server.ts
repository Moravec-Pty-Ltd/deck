import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listProjects, readSettings } from '$lib/server/store';
import { projectStartDefaults } from '$lib/start-defaults-core';
import { expandTilde } from '$lib/server/fsutil';

// What a new session in a project starts with when the caller picks nothing:
// the remembered model/effort per kind, the base branch, the first-prompt
// templates, and claude's permission mode. The same resolver the web modal
// preselects from, published so native clients don't keep a second copy of the
// rules. `project` is a discovery path; unknown paths are a 404.
export const GET: RequestHandler = async ({ url }) => {
	const raw = url.searchParams.get('project');
	if (!raw) error(400, 'project required');
	const path = expandTilde(raw.trim()).replace(/\/+$/, '');
	const project = listProjects().find((p) => p.path === path);
	if (!project) error(404, 'project not found');
	return json(projectStartDefaults(project, readSettings()));
};
