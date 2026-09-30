import { json, error } from '@sveltejs/kit';
import { objectBody } from './http';
import { listProjects, updateProject } from './store';
import { invalidateSessionList } from './sessions';

// Hide or unhide a project, which takes its sessions with it (see
// hidden-core.ts). Its own endpoint rather than a field on POST /api/projects:
// that route rebuilds the whole record from the settings form, and hiding is a
// one-click toggle from the session list, not something the form owns.
//
// Shared verbatim by /api/projects/hidden (browser) and /api/agent/projects/hidden.
function hideRequest(body: Record<string, unknown>): { path: string; hidden: boolean } {
	const path = typeof body.path === 'string' ? body.path.trim() : '';
	if (!path) error(400, 'path required');
	if (typeof body.hidden !== 'boolean') error(400, 'hidden must be a boolean');
	return { path, hidden: body.hidden };
}

export async function setProjectHidden(event: { request: Request }): Promise<Response> {
	const { path, hidden } = hideRequest(await objectBody(event.request));
	if (!listProjects().some((p) => p.path === path)) error(404, 'project not found');
	// `undefined` rather than `false` so unhiding leaves projects.json as it was
	// before the project was ever hidden.
	updateProject(path, { hidden: hidden || undefined });
	// The sessions under it just changed their hidden flag, and the list memo
	// would otherwise keep serving the old one.
	invalidateSessionList();
	return json({ ok: true, path, hidden });
}
