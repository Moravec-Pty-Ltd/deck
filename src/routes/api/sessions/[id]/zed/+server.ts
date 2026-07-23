import { json, error } from '@sveltejs/kit';
import os from 'node:os';
import type { RequestHandler } from './$types';
import { getStoredSession, readSettings } from '$lib/server/store';
import { composeZedSshCommand } from '$lib/zed-command-core';

// The `zed ssh://…` command that opens this session's cwd on the deck host (see
// zed-command-core). Composed server-side because it needs the deck server's user
// and the request hostname; fetched at page load so the copy stays inside the
// click gesture (iOS clipboard). `command` is null for a session with no cwd.
export const GET: RequestHandler = async ({ params, url }) => {
	const session = getStoredSession(params.id);
	if (!session) error(404, 'session not found');
	const command = composeZedSshCommand({
		cwd: session.cwd,
		host: url.hostname,
		user: os.userInfo().username,
		override: readSettings().zedSshTarget
	});
	return json({ command });
};
