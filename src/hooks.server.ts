import type { Handle } from '@sveltejs/kit';
import { redirect, json } from '@sveltejs/kit';
import { authToken, noAuth, printAccessUrl, tokenMatches } from '$lib/server/config';
import { ensureMcp } from '$lib/server/mcp';
import '$lib/server/monitor';

const COOKIE = 'deck_token';

// Start the localhost MCP server (blocking `ask` tool) and shell monitor at boot
// so the MCP port is ready before any claude session spawns.
ensureMcp();

export const handle: Handle = async ({ event, resolve }) => {
	printAccessUrl(event.url.origin);

	if (noAuth) return resolve(event);

	const urlToken = event.url.searchParams.get('token');
	if (tokenMatches(urlToken)) {
		event.cookies.set(COOKIE, authToken, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			maxAge: 60 * 60 * 24 * 365
		});
		const clean = new URL(event.url);
		clean.searchParams.delete('token');
		redirect(302, clean.pathname + clean.search);
	}

	const authed = tokenMatches(event.cookies.get(COOKIE));
	if (!authed && event.url.pathname !== '/login') {
		if (event.url.pathname.startsWith('/api/')) {
			return json({ error: 'unauthorized' }, { status: 401 });
		}
		redirect(302, '/login');
	}

	return resolve(event);
};
