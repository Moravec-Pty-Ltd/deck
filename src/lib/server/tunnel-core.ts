// The dev browser's tunnel (issue #420): what a request to /api/tunnel may ask
// for. The destination host is never the client's to choose: it is always the
// deck machine's loopback, or a remote session's host's loopback.

// `localhost`, not 127.0.0.1: dev servers often bind ::1 only, and resolving the
// name tries both families.
export const TUNNEL_HOST = 'localhost';

export type TunnelRequest = { port: number; session?: string } | { error: string };

const ALLOWED = new Set(['port', 'session']);

export function parseTunnelRequest(params: URLSearchParams): TunnelRequest {
	for (const key of params.keys()) {
		if (!ALLOWED.has(key)) return { error: `unexpected parameter: ${key}` };
	}
	const raw = params.get('port') ?? '';
	const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
	if (!(port >= 1 && port <= 65535)) return { error: 'port must be 1 to 65535' };
	const session = params.get('session');
	if (session === null) return { port };
	if (!/^[\w-]{1,128}$/.test(session)) return { error: 'invalid session' };
	return { port, session };
}

export type Admission = { port: number; session?: string } | { status: number; reason: string };

// Whether a tunnel request goes ahead: a valid deck token, no browser origin, a
// valid request, (when it names one) a session deck knows, and not one of deck's
// own ports on this machine (`ownPorts`: the server's and the MCP server's), which
// a page in the dev browser has no business reaching. Only the native app uses
// this, and it sends no Origin; refusing one keeps a web page from reaching
// every loopback port, even when DECK_NO_AUTH waives the token.
export function admitTunnel(
	authed: boolean,
	origin: string | undefined,
	params: URLSearchParams,
	session: (id: string) => { remote: boolean } | undefined,
	ownPorts: number[]
): Admission {
	if (!authed) return { status: 401, reason: 'Unauthorized' };
	if (origin !== undefined) return { status: 403, reason: 'Forbidden' };
	const request = parseTunnelRequest(params);
	if ('error' in request) return { status: 400, reason: 'Bad Request' };
	const found = request.session ? session(request.session) : undefined;
	if (request.session && !found) return { status: 404, reason: 'Not Found' };
	if (!found?.remote && ownPorts.includes(request.port)) return { status: 403, reason: 'Forbidden' };
	return request;
}
