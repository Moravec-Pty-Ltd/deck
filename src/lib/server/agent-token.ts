import crypto from 'node:crypto';

// The token an agent session gets in DECK_TOKEN (issue #441, S8): its own,
// derived from deck's token so it needs no storage and stops working when that
// token changes, and good only for the agent API minus what reaches credentials,
// devices or project settings. deck's own token stays with deck and its clients.

const PREFIX = 'deck-agent';

function mac(secret: string, sessionId: string): string {
	return crypto.createHmac('sha256', secret).update(`agent:${sessionId}`).digest('base64url');
}

export function agentToken(secret: string, sessionId: string): string {
	return `${PREFIX}.${sessionId}.${mac(secret, sessionId)}`;
}

// The session an agent token belongs to, or null when it is not a valid one.
export function agentTokenSession(secret: string, token: string | null | undefined): string | null {
	// 43 characters: a SHA-256 digest in base64url.
	const m = typeof token === 'string' ? /^deck-agent\.([\w-]{1,128})\.([\w-]{43})$/.exec(token) : null;
	if (!m) return null;
	const want = Buffer.from(mac(secret, m[1]));
	const got = Buffer.from(m[2]);
	return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}

// Agent API routes an agent token may not reach: deck's settings (the operator's
// key file among them), stored credentials and accounts, device pairing, and the
// project settings that decide what verify runs or where a remote project's
// secrets live. Registering a project, which widens what the file routes
// read, is a person's call too. Checked on the route id, which SvelteKit has
// already decoded, so an encoded path cannot slip past; no route, no access.
const AGENT_DENIED = /^\/api\/agent\/(settings|credentials|accounts|pairing|user|projects\/(config|sources|remote))(\/|$)/;
const AGENT_READ_ONLY = /^\/api\/agent\/projects(\/clone)?$/;

export function agentMayReach(routeId: string | null, method: string): boolean {
	if (!routeId || !(routeId === '/api/agent' || routeId.startsWith('/api/agent/'))) return false;
	if (AGENT_DENIED.test(routeId)) return false;
	return !AGENT_READ_ONLY.test(routeId) || method === 'GET' || method === 'HEAD';
}

// Keep in step with the DECK_* variables deck reads (grep the source for
// `env.DECK_`): one missing here reaches every child process.
// deck's own server settings in its environment: a child process has no use for
// them, and DECK_TOKEN is deck's whole access. Other DECK_* variables (a hook's
// DECK_NOTIFY_SCRIPT, say) are the user's and pass through.
const SERVER_VARS = new Set([
	'DECK_TOKEN',
	'DECK_DATA',
	'DECK_NO_AUTH',
	'DECK_NO_AUTH_PUBLIC',
	'DECK_TAILSCALE',
	'DECK_DEMO',
	'DECK_PUSH_SUBJECT',
	'DECK_APNS_KEY_PATH',
	'DECK_APNS_KEY_ID',
	'DECK_APNS_TEAM_ID',
	'DECK_APNS_TOPIC',
	'DECK_MORABOT_STATUS',
	'DECK_SECRETS_FILE',
	'DECK_AGENT_HOME',
	'DECK_TURN_SILENCE_MS',
	'DECK_WATCH_MAX_DELAY'
]);

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([k]) => !SERVER_VARS.has(k)));
}
