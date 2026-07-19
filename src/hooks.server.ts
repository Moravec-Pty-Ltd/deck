import type { Handle, RequestEvent } from '@sveltejs/kit';
import { redirect, json } from '@sveltejs/kit';
import { PUBLIC_PATHS, noAuth, printAccessUrl, requestIsAuthed, setAuthCookie, tokenMatches } from '$lib/server/config';
import { ensureMcp } from '$lib/server/mcp';
import '$lib/server/monitor';

// Start the localhost MCP server (blocking `ask` tool) and shell monitor at boot
// so the MCP port is ready before any claude session spawns.
ensureMcp();

// Exchange a valid ?token= for the session cookie and redirect to a clean URL.
function exchangeUrlToken(event: RequestEvent): never {
	setAuthCookie(event.cookies, event.url.protocol === 'https:');
	const clean = new URL(event.url);
	clean.searchParams.delete('token');
	redirect(302, clean.pathname + clean.search);
}

function deny(event: RequestEvent): Response {
	if (event.url.pathname.startsWith('/api/')) {
		// Unified error shape (issue #144): every /api error body is { message }, the
		// same shape SvelteKit's error() produces, so a client parses one field.
		return json({ message: 'unauthorized' }, { status: 401 });
	}
	redirect(302, '/login');
}

export const handle: Handle = async ({ event, resolve }) => {
	printAccessUrl(event.url.origin);

	if (noAuth) return resolve(event);

	// The agent-API contract doc is public by design (it documents auth, carries
	// no secrets, and a client needs it before it can authenticate).
	if (event.url.pathname === '/llms.txt') return resolve(event);

	// A valid header token (programmatic clients) or session cookie (browsers)
	// authenticates the request outright.
	if (requestIsAuthed(event.request.headers, event.cookies)) return resolve(event);

	// A valid ?token= mints the session cookie and redirects to a clean URL.
	if (tokenMatches(event.url.searchParams.get('token'))) exchangeUrlToken(event);

	if (PUBLIC_PATHS.has(event.url.pathname)) return resolve(event);
	return deny(event);
};
