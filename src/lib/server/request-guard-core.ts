// What the request hook refuses before any route runs (issue #441), free of
// node so the rules are unit tested directly.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function changesState(method: string): boolean {
	return !SAFE_METHODS.has(method.toUpperCase());
}

// host[:port], lower-cased and without a scheme's default port, so a Host header
// of `deck.example.com:443` matches the origin `https://deck.example.com`.
function normalHost(host: string, protocol: string): string | null {
	try {
		return new URL(`${protocol}//${host}`).host || null;
	} catch {
		return null;
	}
}

// Whether a request's Origin is deck itself. An absent Origin passes: the native
// apps and curl send none, and browsers always send one on a state-changing
// request to another site. Hosts are compared rather than whole origins because
// a TLS proxy in front leaves deck unsure of its own scheme.
function originAllowed(origin: string | null, hosts: (string | null | undefined)[]): boolean {
	if (origin === null) return true;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false; // "null" (a sandboxed page) or garbage
	}
	return hosts.some((h) => !!h && normalHost(h, url.protocol) === url.host);
}

// The speech routes take a recording as the raw body.
const SPEECH_ROUTE = /^\/api\/(agent\/)?speech\//;

// The content types an /api body may carry. A browser sends none of them to
// another origin without asking deck first, which deck never grants. Only the
// speech routes take an undeclared type (they read it as audio).
function bodyTypeAllowed(routeId: string, contentType: string | null): boolean {
	const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
	if (type === 'application/json') return true;
	if (!SPEECH_ROUTE.test(routeId)) return false;
	return !type || type === 'application/octet-stream' || /^(audio|video)\//.test(type);
}

function hasBody(headers: Headers): boolean {
	return headers.has('transfer-encoding') || Number(headers.get('content-length') ?? 0) > 0;
}

// The name part of a Host header, '' when it can't be read.
export function hostName(host: string | null): string {
	try {
		return host ? new URL(`http://${host}`).hostname : '';
	} catch {
		return '';
	}
}

export const UNKNOWN_HOST = 'unknown host: reach deck by its IP address or .ts.net name, or turn DECK_NO_AUTH off';

export interface WriteRequest {
	method: string;
	headers: Headers;
	routeId: string | null;
	// Every host[:port] deck is reached at.
	hosts: string[];
}

// Why a state-changing request is turned away, or null when it may go on.
export function refuseWrite({ method, headers, routeId, hosts }: WriteRequest): { status: number; message: string } | null {
	if (!changesState(method)) return null;
	if (!originAllowed(headers.get('origin'), hosts)) {
		return { status: 403, message: 'cross-origin request refused: if a proxy in front rewrites Host, set DECK_BASE_URL to the address you open deck at' };
	}
	if (routeId?.startsWith('/api/') && hasBody(headers) && !bodyTypeAllowed(routeId, headers.get('content-type'))) {
		return { status: 415, message: 'send the body as application/json' };
	}
	return null;
}
