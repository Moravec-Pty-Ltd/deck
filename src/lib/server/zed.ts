import os from 'node:os';
import { error, json } from '@sveltejs/kit';
import { composeZedSshCommand } from '$lib/zed-command-core';
import { getStoredSession, readSettings } from './store';

// GET handler shared by /api/sessions/[id]/zed and /api/agent/sessions/[id]/zed:
// the `zed ssh://...` command that opens this session's cwd on the deck host
// (see zed-command-core). Composed server-side because it needs the deck
// server's user and the request hostname; the web fetches it at page load so the
// copy stays inside the click gesture (iOS clipboard). `command` is null for a
// session with no cwd.
export function zedCommandRoute({ params, url }: { params: Partial<Record<string, string>>; url: URL }): Response {
	const session = getStoredSession(params.id ?? '');
	if (!session) error(404, 'session not found');
	const command = composeZedSshCommand({
		cwd: session.cwd,
		host: url.hostname,
		user: os.userInfo().username,
		override: readSettings().zedSshTarget
	});
	return json({ command });
}
