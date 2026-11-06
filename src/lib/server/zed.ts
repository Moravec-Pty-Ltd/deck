import os from 'node:os';
import { error, json } from '@sveltejs/kit';
import { composeZedSshCommand, composeZedUrl } from '$lib/zed-command-core';
import { probePort } from './devservers';
import { getStoredSession, readSettings } from './store';

// GET handler for /api/agent/sessions/[id]/zed:
// what opens this session's cwd in Zed over SSH on the deck host (see
// zed-command-core). Composed server-side because it needs the deck server's user
// and the request hostname; the web fetches it at page load so the copy stays
// inside the click gesture (iOS clipboard). `command` and `url` are null for a
// session with no cwd. `sshReachable` says whether this host accepts SSH; it is
// null when not checked, since a zedSshTarget points elsewhere and that
// connection reports its own failure.
// shortcut: loopback only, so an sshd bound just to a tailnet address (or Tailscale
// SSH) reads as off; setting zedSshTarget skips the check. Probe the request host
// if that comes up, without slowing every session page load on a tunnel host.
export async function zedCommandRoute({ params, url }: { params: Partial<Record<string, string>>; url: URL }): Promise<Response> {
	const session = getStoredSession(params.id ?? '');
	if (!session) error(404, 'session not found');
	const override = readSettings().zedSshTarget;
	const target = { cwd: session.cwd, host: url.hostname, user: os.userInfo().username, override };
	const command = composeZedSshCommand(target);
	return json({
		command,
		url: composeZedUrl(target),
		sshReachable: command && !override?.trim() ? await probePort(22) : null
	});
}
