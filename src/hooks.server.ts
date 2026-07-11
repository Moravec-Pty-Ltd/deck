import type { Handle, RequestEvent } from '@sveltejs/kit';
import { redirect, json } from '@sveltejs/kit';
import { authToken, headerToken, noAuth, printAccessUrl, tokenMatches } from '$lib/server/config';
import { ensureMcp } from '$lib/server/mcp';
import '$lib/server/monitor';

const COOKIE = 'deck_token';

// Start the localhost MCP server (blocking `ask` tool) and shell monitor at boot
// so the MCP port is ready before any claude session spawns.
ensureMcp();

// Exchange a valid ?token= for the session cookie and redirect to a clean URL.
function exchangeUrlToken(event: RequestEvent): never {
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

function deny(event: RequestEvent): Response {
	if (event.url.pathname.startsWith('/api/')) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	redirect(302, '/login');
}

export const handle: Handle = async ({ event, resolve }) => {
	printAccessUrl(event.url.origin);

	if (noAuth) return resolve(event);

	// The agent-API contract doc is public by design (it documents auth, carries
	// no secrets, and a client needs it before it can authenticate).
	if (event.url.pathname === '/llms.txt') return resolve(event);

	// Programmatic clients authenticate per-request with a header; no cookie.
	if (tokenMatches(headerToken(event.request.headers))) return resolve(event);

	if (tokenMatches(event.url.searchParams.get('token'))) exchangeUrlToken(event);

	const authed = tokenMatches(event.cookies.get(COOKIE));
	if (!authed && event.url.pathname !== '/login') return deny(event);

	return resolve(event);
};
