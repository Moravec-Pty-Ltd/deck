import { json, error } from '@sveltejs/kit';
import { objectBody } from './http';
import { listProjects, updateProject } from './store';
import { invalidateSessionList, listSessions } from './sessions';
import { publishAgentEvent } from './agent-feed';
import { deriveGroup } from '$lib/time';

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

// Tell the feed what changed, one event per session the project owns. The apps
// hold their session list from the feed rather than polling, so without this the
// change only ever reaches the device that made it.
//
// `hidden` is each session's *effective* state, so one hidden on its own stays
// hidden when its project comes back. The project's own state is sent separately
// for exactly that reason: it cannot be read back off the sessions.
async function announce(path: string, projectHidden: boolean): Promise<void> {
	const projects = listProjects();
	for (const session of await listSessions()) {
		if (deriveGroup(session.cwd, projects).key !== path) continue;
		publishAgentEvent(session.id, 'session-hidden', {
			hidden: !!session.hidden,
			project: path,
			projectHidden
		});
	}
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
	await announce(path, hidden);
	return json({ ok: true, path, hidden });
}
