import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { DEMO } from './demo';

// Exported so callers that need a literal filesystem path outside the
// readJson/writeJson helpers (e.g. apns.ts's default key file location) still
// respect a DECK_DATA override in tests.
export const dataDir = process.env.DECK_DATA ?? path.join(os.homedir(), '.deck');
export const transcriptsDir = path.join(dataDir, 'transcripts');
// Per-session resume files for per-turn agents (pi session files, etc).
export const agentSessionsDir = path.join(dataDir, 'agent-sessions');
// User image attachments, stored out-of-band so the transcript JSONL stays small.
export const imagesDir = path.join(dataDir, 'images');
// Durable, monotonically-sequenced agent event log (issue #143): append-only
// JSONL a consumer tails or reads via the /api/agent/events cursor.
export const eventLogFile = path.join(dataDir, 'events.jsonl');

fs.mkdirSync(transcriptsDir, { recursive: true });
fs.mkdirSync(agentSessionsDir, { recursive: true });
fs.mkdirSync(imagesDir, { recursive: true });

// Absolute path to morabot's status.json (issue #188); unset disables the
// integration entirely (no sidebar section, no file reads, no notifications).
// `||` deliberately: a blank env var reads as unset. Confinement (the path must
// resolve inside a registered project) is validated where it's consumed, in
// server/morabot.ts, to avoid a config -> confine -> store -> config import cycle.
export const morabotStatusPath = process.env.DECK_MORABOT_STATUS?.trim() || null;

const tokenFile = path.join(dataDir, 'token');

function loadToken(): string {
	if (process.env.DECK_TOKEN) return process.env.DECK_TOKEN;
	if (fs.existsSync(tokenFile)) {
		// An empty/whitespace file would yield an empty token, which the auth gate
		// would then accept from any empty credential. Treat it as absent and mint a
		// fresh one.
		const existing = fs.readFileSync(tokenFile, 'utf8').trim();
		if (existing) return existing;
	}
	const token = crypto.randomBytes(24).toString('hex');
	fs.writeFileSync(tokenFile, token, { mode: 0o600 });
	return token;
}

export const authToken = loadToken();

// The browser session credential. Both the ?token= gate (exchangeUrlToken in
// hooks.server.ts) and the pairing status endpoint mint this same cookie, so its
// name and options live here as the single source of truth. A year-long httpOnly
// cookie: deck is a trusted single-user tool on a LAN/tailnet.
export const AUTH_COOKIE = 'deck_token';

export function setAuthCookie(cookies: Cookies, secure: boolean) {
	cookies.set(AUTH_COOKIE, authToken, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: 60 * 60 * 24 * 365
	});
}

// Where a programmatic client reaches this deck server. Stamped into spawned
// agents' env (DECK_BASE_URL) and printed in /llms.txt; override when deck is
// reached at something other than localhost (the fallback tracks the runtime
// PORT so a non-default port still yields working URLs). `||` deliberately:
// a blank env var reads as unset.
export const baseUrl = (
	process.env.DECK_BASE_URL?.trim() || `http://localhost:${process.env.PORT?.trim() || 4818}`
).replace(/\/+$/, '');

// Shared-token credential carried in request headers by programmatic clients
// (browsers use the deck_token cookie instead): `Authorization: Bearer <token>`
// or `X-Deck-Token: <token>`. Values are trimmed (a shell-built header easily
// picks up a stray newline) and an empty header reads as missing.
export function headerToken(headers: Headers): string | null {
	const auth = headers.get('authorization');
	if (auth) {
		const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
		if (m) return m[1];
	}
	return headers.get('x-deck-token')?.trim() || null;
}

// Pre-hash the secret once so request-time comparison hits a fixed-length digest.
const authTokenHash = crypto.createHash('sha256').update(authToken).digest();

// Constant-time token check. Hashing both sides to a fixed-length digest equalises
// length (so we leak neither a prefix-match signal nor the token length) and keeps
// timingSafeEqual happy, which throws on length-mismatched buffers. A non-string
// candidate (missing query param / cookie) can never match.
export function tokenMatches(candidate: string | null | undefined): boolean {
	if (typeof candidate !== 'string') return false;
	const candidateHash = crypto.createHash('sha256').update(candidate).digest();
	return crypto.timingSafeEqual(candidateHash, authTokenHash);
}

// Paths an unauthenticated client may reach: the token-paste login, the pairing
// request flow (a new device asking for access), and the public agent-API
// contract. Shared by the request hook and the root layout guard so the two gates
// never disagree on what's public.
export const PUBLIC_PATHS = new Set(['/login', '/pair', '/api/pair/request', '/api/pair/status']);

// Does this request already carry a valid credential - the per-request header
// token (programmatic clients) or the session cookie (browsers)? Shared by the
// request hook and the root layout load so the token check lives in one place
// (issue #164). The ?token= URL exchange stays in the hook: it mints the cookie.
export function requestIsAuthed(headers: Headers, cookies: Cookies): boolean {
	return tokenMatches(headerToken(headers)) || tokenMatches(cookies.get(AUTH_COOKIE));
}

// Whether the DECK_NO_AUTH env flag (as opposed to demo mode) asked to drop the
// token gate. Kept separate so the public-host guardrail below only second-guesses
// a real deployment, never the canned demo dataset.
const noAuthRequested = process.env.DECK_NO_AUTH === '1' || process.env.DECK_NO_AUTH === 'true';

// Explicit acknowledgement that no-auth on a non-private host is intended (an
// authenticating proxy is in front). Skips the guardrail's refusal and its
// warnings.
const noAuthPublicAck =
	process.env.DECK_NO_AUTH_PUBLIC === '1' || process.env.DECK_NO_AUTH_PUBLIC === 'true';

// Private/loopback/CGNAT IPv4 bands, as [firstOctet, minSecond, maxSecond]:
// loopback, the three RFC1918 blocks, link-local, and the Tailscale 100.64.0.0/10
// CGNAT range.
const PRIVATE_IPV4: [number, number, number][] = [
	[127, 0, 255],
	[10, 0, 255],
	[192, 168, 168],
	[172, 16, 31],
	[169, 254, 254],
	[100, 64, 127]
];

function isPrivateIpv4(h: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	return PRIVATE_IPV4.some(([first, lo, hi]) => a === first && b >= lo && b <= hi);
}

// IPv6 literal: loopback (::1), unique-local (fc00::/7), or link-local. The
// link-local block is fe80::/10, so its first hextet runs fe80-febf, not just
// fe80.
function isPrivateIpv6(h: string): boolean {
	if (h === '::1') return true;
	if (h.startsWith('fc') || h.startsWith('fd')) return true;
	return /^fe[89ab][0-9a-f]:/.test(h);
}

// Is `host` provably a private access boundary? Loopback, a Tailscale address (a
// `.ts.net` MagicDNS name or the 100.64.0.0/10 CGNAT range), or an RFC1918 /
// link-local LAN address. Anything else - a public tunnel hostname, a routable IP,
// or an unparseable/empty host - is treated as not private (issue #163).
export function isPrivateHost(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
	if (!h) return false;
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	if (h.endsWith('.ts.net')) return true;
	return h.includes(':') ? isPrivateIpv6(h) : isPrivateIpv4(h);
}

function hostFromBaseUrl(): string {
	for (const candidate of [baseUrl, `http://${baseUrl}`]) {
		try {
			// A scheme-less base URL like `localhost:4818` parses with `localhost:` as
			// the protocol and an empty hostname, so only accept a non-empty hostname
			// and otherwise fall through to the http://-prefixed form.
			const { hostname } = new URL(candidate);
			if (hostname) return hostname;
		} catch {
			// Try the scheme-prefixed form next; give up (unknown host) if both fail.
		}
	}
	return '';
}

// DECK_NO_AUTH drops the token gate on the assumption that a private network path
// (Tailscale, loopback, a LAN) is the real access boundary. deck can't see that
// path, so it uses the configured host as the signal: if no-auth is on but the
// host isn't obviously private, it's likely a public tunnel and the flag would
// fling every route open to the internet (issue #163). Fail safe - keep the gate
// on - unless DECK_NO_AUTH_PUBLIC=1 acknowledges the risk. Either way, warn loudly.
function resolveNoAuth(): boolean {
	if (DEMO) return true; // canned dataset; nothing real to expose
	if (!noAuthRequested) return false;
	const host = hostFromBaseUrl();
	if (isPrivateHost(host)) return true;
	const shown = host || baseUrl;
	if (noAuthPublicAck) {
		console.warn(
			`[deck] WARNING: DECK_NO_AUTH is on and ${shown} is not a private host. Every route is served UNAUTHENTICATED to anyone who can reach this URL (DECK_NO_AUTH_PUBLIC=1 acknowledged). Prefer the token or QR/pairing flow for tunnelled access.`
		);
		return true;
	}
	console.error(
		`[deck] Ignoring DECK_NO_AUTH: ${shown} is not obviously private (not loopback, Tailscale, or a LAN address), so the token gate stays ON rather than exposing deck unauthenticated on a public URL. Use the token or QR/pairing flow, or set DECK_NO_AUTH_PUBLIC=1 to override if this path really is private.`
	);
	return false;
}

// When fronted by Tailscale, the tailnet is the access boundary and the token gate
// is redundant; DECK_NO_AUTH=1 (or demo mode) skips it. On a non-private host the
// flag is refused unless DECK_NO_AUTH_PUBLIC=1 - see resolveNoAuth / issue #163.
export const noAuth = resolveNoAuth();

// Request-time backstop for the boot guardrail. The boot check keys off
// DECK_BASE_URL; if that's left at its localhost default while deck is actually
// reached over a public tunnel, no-auth still slips through. Observing the real
// request Host catches that and warns loudly, once. Deliberately a warning, not a
// gate: the Host header is spoofable (a request can claim Host: localhost), so it
// can't decide the bypass - the token stays the real boundary for public tunnels
// (issue #163).
let warnedPublicNoAuthHost = false;
export function warnIfPublicNoAuthHost(hostname: string) {
	if (warnedPublicNoAuthHost || !noAuth || !noAuthRequested || noAuthPublicAck) return;
	if (isPrivateHost(hostname)) return;
	warnedPublicNoAuthHost = true;
	console.error(
		`[deck] WARNING: DECK_NO_AUTH is serving requests on public host ${hostname} unauthenticated. If deck is reached over a public tunnel, unset DECK_NO_AUTH and carry the token (or set DECK_BASE_URL so the boot check can refuse). See the README on remote access.`
	);
}

let printed = false;
export function printAccessUrl(origin: string) {
	if (printed) return;
	printed = true;
	console.log(noAuth ? `[deck] access: ${origin}/ (no auth)` : `[deck] access: ${origin}/?token=${authToken}`);
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')) as T;
	} catch {
		return fallback;
	}
}

// A cheap freshness token for a data file: its last-modified time in ms, or null
// if it can't be stat'd (the file doesn't exist yet, or a transient IO error). A
// cached reader compares this against the mtime it last read at to notice that
// another process (e.g. a second deck server sharing ~/.deck) rewrote the file,
// without re-parsing it on every access.
export function fileMtimeMs(file: string): number | null {
	try {
		return fs.statSync(path.join(dataDir, file)).mtimeMs;
	} catch {
		return null;
	}
}

// `mode` (e.g. 0o600 for secrets) is applied to the temp file and survives the
// rename. Open with the mode up front so the file never exists world-readable,
// then chmod as well in case the temp path pre-existed with a looser mode
// (open's mode is ignored when the file already exists, and is umask-masked).
export function writeJson(file: string, value: unknown, mode?: number) {
	const target = path.join(dataDir, file);
	const tmp = `${target}.tmp`;
	const data = JSON.stringify(value, null, '\t');
	if (mode === undefined) {
		fs.writeFileSync(tmp, data);
	} else {
		const fd = fs.openSync(tmp, 'w', mode);
		try {
			fs.writeFileSync(fd, data);
		} finally {
			fs.closeSync(fd);
		}
		fs.chmodSync(tmp, mode);
	}
	fs.renameSync(tmp, target);
}
