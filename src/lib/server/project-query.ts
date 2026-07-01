import { error } from '@sveltejs/kit';
import type { Project } from '$lib/types';
import { listProjects } from './store';

// Shared query parsing for the project-scoped list endpoints (/api/issues,
// /api/prs): resolve the ?project=<path> to a registered project and read the
// ?refresh flag, 404-ing an unknown path. Both endpoints then hand the project
// to their own aggregator.
export function projectFromQuery(url: URL): { project: Project; refresh: boolean } {
	const path = url.searchParams.get('project');
	if (!path) error(400, 'project required');
	const project = listProjects().find((p) => p.path === path);
	if (!project) error(404, 'project not found');
	const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
	return { project, refresh };
}
