import type { Handle, RequestEvent } from '@sveltejs/kit';
import { redirect, json } from '@sveltejs/kit';
import { AUTH_COOKIE, headerToken, noAuth, printAccessUrl, setAuthCookie, tokenMatches } from '$lib/server/config';
import { ensureMcp } from '$lib/server/mcp';
import '$lib/server/monitor';

// Paths an unauthenticated browser may reach: the token-paste login, the pairing
// request flow (a new device asking for access), and the public agent-API contract.
// Everything else falls through to the auth gate. The pairing approve/pending
// endpoints are deliberately absent - they require an already-authenticated browser.
const PUBLIC_PATHS = new Set(['/login', '/pair', '/api/pair/request', '/api/pair/status']);

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

	// Programmatic clients authenticate per-request with a header; no cookie.
	if (tokenMatches(headerToken(event.request.headers))) return resolve(event);

	if (tokenMatches(event.url.searchParams.get('token'))) exchangeUrlToken(event);

	const authed = tokenMatches(event.cookies.get(AUTH_COOKIE));
	if (!authed && !PUBLIC_PATHS.has(event.url.pathname)) return deny(event);

	return resolve(event);
};
