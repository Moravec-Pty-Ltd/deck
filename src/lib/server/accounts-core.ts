import { SHARED_PARTS, type ClaudeAccount, type SharedPart } from '$lib/types';

// Pure account logic: names, where an account's config directory lives, the
// env a session runs under, and what to link from the default config. The
// sibling accounts.ts binds it to the settings file, the secret store, the
// filesystem and `claude auth status`.

const DEFAULT_ACCOUNT = 'Default';

// Also a directory name under claude-accounts/, so no separators or dot-only names.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function accountNameProblem(name: unknown): string | null {
	if (typeof name !== 'string' || !NAME_RE.test(name)) {
		return 'account name must be letters, digits, dot, dash or underscore (up to 64)';
	}
	if (name.toLowerCase() === DEFAULT_ACCOUNT.toLowerCase()) return `"${DEFAULT_ACCOUNT}" is built in`;
	return null;
}

function parseShare(raw: unknown, existing: SharedPart[] | undefined): SharedPart[] | undefined {
	if (raw === undefined) return existing;
	if (!Array.isArray(raw) || raw.some((p) => !SHARED_PARTS.includes(p))) {
		throw new Error(`share must list parts from: ${SHARED_PARTS.join(', ')}`);
	}
	return raw.length ? [...new Set(raw as SharedPart[])] : undefined;
}

// An add or update body over the stored accounts; throws on a bad field. `kind`
// is required to add, and the returned apiKey is undefined when not sent.
export function parseAccount(
	body: Record<string, unknown>,
	accounts: ClaudeAccount[]
): { account: ClaudeAccount; existing?: ClaudeAccount; apiKey?: string } {
	const problem = accountNameProblem(body.name);
	if (problem) throw new Error(problem);
	const name = body.name as string;
	const existing = findAccount(accounts, name);
	// Names are directories, and macOS matches them case-insensitively.
	if (!existing && accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
		throw new Error(`an account named ${name} already exists`);
	}
	const kind = body.kind ?? existing?.kind;
	if (kind !== 'login' && kind !== 'api') throw new Error('kind must be login or api');
	if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw new Error('apiKey must be a string');
	if (kind === 'login' && body.apiKey) throw new Error('a login account takes no API key');
	const account: ClaudeAccount = { ...existing, name, kind };
	const share = parseShare(body.share, existing?.share);
	if (share) account.share = share;
	else delete account.share;
	// Only an exact '' clears a stored key; blank whitespace is no key at all.
	const apiKey = body.apiKey === '' ? '' : (body.apiKey as string | undefined)?.trim() || undefined;
	return { account, existing, apiKey };
}

export function findAccount(accounts: ClaudeAccount[] | undefined, name: string): ClaudeAccount | undefined {
	return accounts?.find((a) => a.name === name);
}

export function accountDir(dataDir: string, name: string): string {
	return `${dataDir}/claude-accounts/${name}`;
}

// Kept in the secret store, never in settings.json. Source ids are UUIDs, so
// this prefix cannot collide with an issue-source key.
export function accountSecretId(name: string): string {
	return `claude-account:${name}`;
}

export function loginCommand(dir: string): string {
	return `CLAUDE_CONFIG_DIR='${dir.replaceAll("'", `'\\''`)}' claude auth login`;
}

// Variables that choose claude's credentials or backend: every Anthropic and
// cloud setting. A non-default account must never inherit them from deck's own
// env or a shared settings.json, or a client's work would quietly run on the
// personal ones. Matched by prefix, since each provider keeps adding names.
const CREDENTIAL_PREFIXES = [
	'ANTHROPIC_',
	'AWS_',
	'GOOGLE_',
	'CLOUD_ML_',
	'CLOUDSDK_',
	'CLAUDE_CODE_USE_',
	'CLAUDE_CODE_SKIP_',
	'CLAUDE_CODE_OAUTH_TOKEN'
];

function isCredentialVar(name: string): boolean {
	return CREDENTIAL_PREFIXES.some((p) => name.startsWith(p));
}

// settings.json keys that run a command to fetch credentials.
const CREDENTIAL_SETTINGS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh'];

// What in a settings.json would supply credentials or a backend, by name.
export function settingsCredentials(settings: unknown): string[] {
	if (!settings || typeof settings !== 'object') return [];
	const s = settings as { env?: unknown };
	const env = s.env && typeof s.env === 'object' && !Array.isArray(s.env) ? Object.keys(s.env) : [];
	return [...CREDENTIAL_SETTINGS.filter((k) => k in s), ...env.filter(isCredentialVar).map((k) => `env.${k}`)];
}

// `inherited` is the names in deck's own env; each credential among them is
// dropped (undefined: spawn ignores undefined env values) before the account's own.
export function accountEnv(
	account: ClaudeAccount,
	dir: string,
	apiKey: string | undefined,
	inherited: string[]
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = Object.fromEntries(
		inherited.filter(isCredentialVar).map((k) => [k, undefined])
	);
	if (account.kind === 'api') {
		Object.assign(env, account.env);
		if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
	}
	env.CLAUDE_CONFIG_DIR = dir;
	return env;
}

// A cloud provider switched on needs its own credential in the account env, or
// the SDK falls back to the machine's default chain (~/.aws, gcloud), which is
// the user's own identity. Without a switch, an Anthropic key or token will do.
const PROVIDERS: [string, string[]][] = [
	[
		'CLAUDE_CODE_USE_BEDROCK',
		['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE']
	],
	['CLAUDE_CODE_USE_VERTEX', ['GOOGLE_APPLICATION_CREDENTIALS']],
	['CLAUDE_CODE_USE_FOUNDRY', ['ANTHROPIC_FOUNDRY_API_KEY']]
];
const DIRECT = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

function apiAccountProblem(name: string, env: Record<string, unknown>, storedKey: boolean): string | null {
	const set = (k: string) => typeof env[k] === 'string' && !!(env[k] as string).trim();
	// The CLI's own reading of a switch.
	const on = (k: string) => typeof env[k] === 'string' && /^(1|true|yes|on)$/i.test(env[k] as string);
	const sw = Object.keys(env).find((k) => k.startsWith('CLAUDE_CODE_USE_') && on(k));
	if (!sw) return storedKey || DIRECT.some(set) ? null : `Account ${name} has no API key`;
	const creds = PROVIDERS.find(([p]) => p === sw)?.[1];
	if (!creds) return `Account ${name} turns on ${sw}, which deck cannot check`;
	return creds.some(set) ? null : `Account ${name} turns on ${sw} but sets none of ${creds.join(', ')}`;
}

// A model profile is another backend, so it gets the account's config directory
// but not the account's Anthropic key unless it names its own. Default sessions
// keep the plain merge they always had.
export function sessionEnv(
	account: Record<string, string | undefined> | undefined,
	profile: Record<string, string> | undefined
): Record<string, string | undefined> | undefined {
	if (!account || !profile) return account || profile ? { ...account, ...profile } : undefined;
	return { ...account, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ...profile };
}

// `claude auth status` methods that mean the directory's own `claude auth login`.
// Anything else (api_key_helper, oauth_token, ...) comes from somewhere else.
const OWN_LOGIN = ['claude.ai', 'console'];

export interface Readiness {
	authMethod?: string;
	apiKey?: boolean;
	// settingsCredentials of the shared settings.json, when it is shared.
	sharedCredentials?: string[];
}

// Why a session cannot start under this account, or null when it can.
export function notReadyReason(name: string, account: ClaudeAccount | undefined, r: Readiness): string | null {
	if (!account) return `Account ${name} does not exist`;
	if (r.sharedCredentials?.length) {
		return `Account ${name} shares settings.json, which sets ${r.sharedCredentials.join(', ')}; stop sharing it`;
	}
	if (account.kind === 'login') {
		return r.authMethod && OWN_LOGIN.includes(r.authMethod) ? null : `Account ${name} is not logged in`;
	}
	return apiAccountProblem(name, account.env ?? {}, !!r.apiKey);
}

export type LinkState = 'missing' | 'ours' | 'other';

// One shared part of the default config: link it when shared and absent, drop
// our own link when no longer shared, and never touch a real file or directory
// the account made itself.
export function linkAction(shared: boolean, state: LinkState, sourceExists: boolean): 'link' | 'unlink' | null {
	if (shared && state === 'missing' && sourceExists) return 'link';
	if (!shared && state === 'ours') return 'unlink';
	return null;
}
