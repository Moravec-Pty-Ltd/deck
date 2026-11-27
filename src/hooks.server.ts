import type { Handle, RequestEvent } from '@sveltejs/kit';
import { redirect, json } from '@sveltejs/kit';
import { AUTH_COOKIE, PUBLIC_PATHS, authToken, baseHost, headerToken, noAuth, noAuthHostAllowed, printAccessUrl, setAuthCookie, tokenMatches } from '$lib/server/config';
import { requestIsAuthed } from '$lib/server/auth';
import { addDevice } from '$lib/server/devices';
import { upgradesCookie } from '$lib/server/devices-core';
import { agentMayReach, agentTokenSession } from '$lib/server/agent-token';
import { getStoredSession } from '$lib/server/store';
import { UNKNOWN_HOST, hostName, refuseWrite } from '$lib/server/request-guard-core';
import { ensureMcp } from '$lib/server/mcp';
import { initSecrets } from '$lib/server/secrets';
import '$lib/server/monitor';
import '$lib/server/live-activity';
import '$lib/server/auto-compact';
import '$lib/server/tunnel';

// Start the localhost MCP server (blocking `ask` tool) and shell monitor at boot
// so the MCP port is ready before any claude session spawns.
ensureMcp();

// Resolve the secret store before serving anything: an unusable OS keyring is a
// startup failure, and an existing plaintext secrets.json migrates here (see
// secrets.ts).
initSecrets();

function deny(event: RequestEvent): Response {
	if (event.url.pathname.startsWith('/api/')) {
		// Unified error shape (issue #144): every /api error body is { message }, the
		// same shape SvelteKit's error() produces, so a client parses one field.
		return json({ message: 'unauthorized' }, { status: 401 });
	}
	redirect(302, '/login');
}

function unknownHost(host: string) {
	return noAuth && !noAuthHostAllowed(hostName(host)) ? { status: 403, message: UNKNOWN_HOST } : null;
}

// The refusal a request gets before auth, or null when it may go on. The Host
// header is read directly: ORIGIN pins event.url whatever the client asked for.
// The route id, not the path, names the route: the path may be percent-encoded.
function refuse({ request, url, route }: RequestEvent): Response | null {
	const host = request.headers.get('host') ?? url.host;
	const refused = unknownHost(host) ?? refuseWrite({ method: request.method, headers: request.headers, routeId: route.id, hosts: [host, url.host, baseHost] });
	return refused && json({ message: refused.message }, { status: refused.status });
}

// same-origin, not no-referrer: the latter makes browsers send `Origin: null` on
// deck's own form posts, which refuse() turns away.
function secure(response: Response): Response {
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'same-origin');
	return response;
}

// Whether a request goes straight through: no-auth mode, the agent-API contract
// doc (public by design: it documents auth, carries no secrets, and a client needs
// it before it can authenticate), a valid header token (programmatic clients) or
// the session cookie (browsers).
function admitted(event: RequestEvent): boolean {
	if (noAuth || event.url.pathname === '/llms.txt') return true;
	return requestIsAuthed(event.request.headers, event.cookies) || agentAdmitted(event);
}

// An agent session's own token (S8): good for the agent API, minus settings,
// credentials, pairing and project config, while its session exists.
function agentAdmitted({ request, route }: RequestEvent): boolean {
	const id = agentTokenSession(authToken, headerToken(request.headers));
	return !!id && agentMayReach(route.id, request.method) && !!getStoredSession(id);
}

// A browser signed in before devices had their own credentials carries deck's
// token in its cookie: swap it for a device credential, so it can be revoked
// and the token rotated without signing it out.
// Only on a page load, which a browser makes one at a time and whose Set-Cookie
// it keeps; parallel API calls, or a client that drops cookies, would each mint one.
function upgradeCookie(event: RequestEvent): void {
	if (!upgradesCookie(event.request.method, event.request.headers.get('sec-fetch-mode'))) return;
	if (!tokenMatches(event.cookies.get(AUTH_COOKIE))) return;
	const { credential } = addDevice(event.request.headers.get('user-agent') ?? 'Browser');
	setAuthCookie(event.cookies, event.url.protocol === 'https:', credential);
}

const authenticate: Handle = async ({ event, resolve }) => {
	if (!admitted(event)) return PUBLIC_PATHS.has(event.url.pathname) ? resolve(event) : deny(event);
	upgradeCookie(event);
	return resolve(event);
};

export const handle: Handle = async ({ event, resolve }) => {
	printAccessUrl(event.url.origin);
	return secure(refuse(event) ?? (await authenticate({ event, resolve })));
};
