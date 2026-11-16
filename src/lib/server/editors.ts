import os from 'node:os';
import { error, json } from '@sveltejs/kit';
import { composeEditorLinks } from '$lib/editors-core';
import { probePort } from './devservers';
import { getStoredSession, readSettings } from './store';

type RouteEvent = { params: Partial<Record<string, string>>; url: URL };

// What opens this session's cwd over SSH on the deck host (see editors-core).
// Composed server-side because it needs the deck server's user and the request
// hostname; the web fetches it at page load so the copy stays inside the click
// gesture (iOS clipboard). `sshReachable` says whether this host accepts SSH; it is
// null when not checked, since a zedSshTarget points elsewhere and that connection
// reports its own failure.
// shortcut: loopback only, so an sshd bound just to a tailnet address (or Tailscale
// SSH) reads as off; setting zedSshTarget skips the check. Probe the request host
// if that comes up, without slowing every session page load on a tunnel host.
async function sessionEditors({ params, url }: RouteEvent) {
	const session = getStoredSession(params.id ?? '');
	if (!session) error(404, 'session not found');
	// The checkout is on another host; an editor link here would open the local anchor.
	if (session.remote) return { editors: [], sshReachable: null };
	const override = readSettings().zedSshTarget;
	const editors = composeEditorLinks({ cwd: session.cwd, host: url.hostname, user: os.userInfo().username, override });
	return { editors, sshReachable: editors.length > 0 && !override?.trim() ? await probePort(22) : null };
}

// GET /api/agent/sessions/[id]/editors
export async function editorsRoute(event: RouteEvent): Promise<Response> {
	return json(await sessionEditors(event));
}

// GET /api/agent/sessions/[id]/zed: the Zed entry alone, for apps from before the
// editor list. `command` and `url` are null for a session with no cwd.
export async function zedCommandRoute(event: RouteEvent): Promise<Response> {
	const { editors, sshReachable } = await sessionEditors(event);
	const zed = editors.find((editor) => editor.scheme === 'zed');
	return json({ command: zed?.command ?? null, url: zed?.url ?? null, sshReachable });
}
