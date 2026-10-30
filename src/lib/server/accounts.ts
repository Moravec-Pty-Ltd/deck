import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SHARED_PARTS, type ClaudeAccount, type ClaudeAccountView } from '$lib/types';
import { dataDir } from './config';
import { readSettings, saveSettings } from './store';
import { deleteSecret, readSecret, setSecret } from './secrets';
import { AGENT_BINARIES } from './agents/binaries';
import * as core from './accounts-core';

const exec = promisify(execFile);

// The Default account's config: what deck's own environment points claude at.
const defaultConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function accounts(): ClaudeAccount[] {
	return readSettings().claudeAccounts ?? [];
}

export function accountExists(name: string): boolean {
	return !!core.findAccount(accounts(), name);
}

interface AuthStatus {
	authMethod?: string;
	email?: string;
	orgName?: string;
}

// The CLI's own answer, per config directory (about 150 ms). Any failure reads
// as not logged in, so a broken check refuses rather than lets a session through.
async function authStatus(env: Record<string, string | undefined>): Promise<AuthStatus> {
	try {
		const { stdout } = await exec(AGENT_BINARIES.claude, ['auth', 'status', '--json'], {
			env: { ...process.env, ...env },
			timeout: 15_000
		});
		return JSON.parse(stdout) as AuthStatus;
	} catch {
		return {};
	}
}

function linkState(target: string, source: string): core.LinkState {
	try {
		if (!fs.lstatSync(target).isSymbolicLink()) return 'other';
		return fs.readlinkSync(target) === source ? 'ours' : 'other';
	} catch {
		return 'missing';
	}
}

// Create the account's config directory and bring its links to the default
// config in line with `share`.
function prepareDir(account: ClaudeAccount): string {
	const dir = core.accountDir(dataDir, account.name);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const part of SHARED_PARTS) {
		const source = path.join(defaultConfigDir, part);
		const target = path.join(dir, part);
		const action = core.linkAction(!!account.share?.includes(part), linkState(target, source), fs.existsSync(source));
		if (action === 'link') fs.symlinkSync(source, target);
		else if (action === 'unlink') fs.unlinkSync(target);
	}
	return dir;
}

// A missing or unreadable file shares nothing, so it has nothing to report.
function sharedSettingsCredentials(account: ClaudeAccount): string[] {
	if (!account.share?.includes('settings.json')) return [];
	try {
		return core.settingsCredentials(JSON.parse(fs.readFileSync(path.join(defaultConfigDir, 'settings.json'), 'utf8')));
	} catch {
		return [];
	}
}

async function resolve(account: ClaudeAccount) {
	const dir = prepareDir(account);
	const apiKey = account.kind === 'api' ? readSecret(core.accountSecretId(account.name)) : undefined;
	const env = core.accountEnv(account, dir, apiKey, Object.keys(process.env));
	const status: AuthStatus = account.kind === 'login' ? await authStatus(env) : {};
	const reason = core.notReadyReason(account.name, account, {
		authMethod: status.authMethod,
		apiKey: !!apiKey,
		sharedCredentials: sharedSettingsCredentials(account)
	});
	return { dir, env, status, reason };
}

async function check(name: string | undefined) {
	if (!name) return { reason: null, env: undefined };
	const account = core.findAccount(accounts(), name);
	return account ? resolve(account) : { reason: core.notReadyReason(name, undefined, {}), env: undefined };
}

// Why a session under `name` cannot start, or null (always null for Default).
export async function accountProblem(name: string | undefined): Promise<string | null> {
	return (await check(name)).reason;
}

// The env a session under `name` runs with; undefined for Default. Throws the
// reason when the account cannot run, so the session fails rather than falls
// back to the default login.
export async function sessionAccountEnv(
	name: string | undefined
): Promise<Record<string, string | undefined> | undefined> {
	const { reason, env } = await check(name);
	if (reason) throw new Error(reason);
	return env;
}

// A locked keyring or an unwritable directory marks this one account, not the list.
async function view(account: ClaudeAccount): Promise<ClaudeAccountView> {
	const { dir, status, reason } = await resolve(account).catch((e: unknown) => ({
		dir: core.accountDir(dataDir, account.name),
		status: {} as AuthStatus,
		reason: `Account ${account.name} could not be checked: ${e instanceof Error ? e.message : e}`
	}));
	return {
		name: account.name,
		kind: account.kind,
		share: account.share ?? [],
		envKeys: Object.keys(account.env ?? {}),
		configDir: dir,
		...(account.kind === 'login' && { loginCommand: core.loginCommand(dir) }),
		ready: !reason,
		...(reason && { problem: reason }),
		...(status.email && { email: status.email }),
		...(status.orgName && { org: status.orgName })
	};
}

export function listAccountViews(): Promise<ClaudeAccountView[]> {
	return Promise.all(accounts().map(view));
}

// Add an account or update one. `env` stays a settings.json-only field, like a
// model profile's; an `apiKey` goes to the secret store and an empty one clears it.
export async function saveAccount(body: Record<string, unknown>): Promise<ClaudeAccountView> {
	const list = accounts();
	const { account, existing, apiKey } = core.parseAccount(body, list);
	// A new key before the settings and a removal after, so a failure in either
	// write never leaves the stored account without the key it had.
	const secretId = core.accountSecretId(account.name);
	if (account.kind === 'api' && apiKey) setSecret(secretId, apiKey);
	saveSettings({
		...readSettings(),
		claudeAccounts: existing ? list.map((a) => (a === existing ? account : a)) : [...list, account]
	});
	if (apiKey === '' || (account.kind === 'login' && existing?.kind === 'api')) deleteSecret(secretId);
	return view(account);
}

// Leaves the config directory, which holds the account's login and history, so
// re-adding the name picks them back up. Sessions and projects still naming it
// fail to start rather than fall back to Default.
export function deleteAccount(name: string): void {
	const list = accounts();
	if (!core.findAccount(list, name)) return;
	saveSettings({ ...readSettings(), claudeAccounts: list.filter((a) => a.name !== name) });
	deleteSecret(core.accountSecretId(name));
}
