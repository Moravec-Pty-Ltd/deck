import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeckSession, Project, ProjectRemote } from '$lib/types';
import {
	claudeScript,
	destination,
	killScript,
	parseTarget,
	remoteCommand,
	shellJoin,
	shellQuote,
	sshFailure,
	sshOptions,
	type SshTarget
} from '$lib/remote-core';
import { dataDir } from './config';
import { listProjects } from './store';
import { projectForPath } from './confine';
import { deleteSecret, readSecret, setSecret } from './secrets';
import { resolveSecretsFile } from './secrets-file';
import { spawnAgent } from './agents/spawn';

// Running a project's sessions on another host over SSH (issue #410). Every
// ssh call goes through one ControlMaster socket per host, so the stored
// password or passphrase is used once per connection, handed over by an
// askpass helper that reads it from that ssh child's environment: never argv.

export interface RemoteConn {
	target: SshTarget;
	// ssh options plus the destination, ready for the remote command.
	args: string[];
	env: NodeJS.ProcessEnv;
}

const sshDir = path.join(dataDir, 'ssh');
const knownHosts = path.join(dataDir, 'known_hosts');
const askpass = path.join(sshDir, 'askpass.sh');
const SECRET_ENV = 'DECK_SSH_SECRET';

// A unix socket path is capped near 104 bytes and %C expands to 40 hex chars.
function controlDir(): string {
	return sshDir.length + 42 < 100 ? sshDir : path.join(os.tmpdir(), `deck-ssh-${process.getuid?.() ?? 'u'}`);
}

function ensureFiles() {
	for (const dir of new Set([sshDir, controlDir()])) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!fs.existsSync(askpass)) fs.writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' "$${SECRET_ENV}"\n`, { mode: 0o700 });
}

const secretId = (projectPath: string) => `ssh:${projectPath}`;

export function readRemoteSecret(projectPath: string): string | undefined {
	return readSecret(secretId(projectPath)) || undefined;
}

export function saveRemoteSecret(projectPath: string, secret: string) {
	setSecret(secretId(projectPath), secret);
}

export function removeRemoteSecret(projectPath: string) {
	deleteSecret(secretId(projectPath));
}

export const IDENTITY_FILE_RULE = 'remote.auth.identityFile must be a key file inside ~/.ssh/';

export function resolveIdentityFile(file: string): string | null {
	return resolveSecretsFile(file, '.ssh');
}

// The connection for a project's remote. `target` overrides the project's (a
// session keeps the host it was created on).
export function connectionFor(projectPath: string, remote: ProjectRemote, target = remote.target): RemoteConn {
	const parsed = parseTarget(target);
	if (!parsed) throw new Error(`invalid remote target: ${target}`);
	ensureFiles();
	const { auth } = remote;
	const secret = auth.kind === 'default' ? undefined : readRemoteSecret(projectPath);
	let identityFile: string | undefined;
	if (auth.kind === 'key') {
		identityFile = resolveIdentityFile(auth.identityFile) ?? undefined;
		if (!identityFile) throw new Error(IDENTITY_FILE_RULE);
	}
	if (auth.kind === 'password' && !secret) throw new Error(`no password is saved for ${target}: add it in the project's Remote settings`);
	const opts = sshOptions({ auth, port: parsed.port, hasSecret: !!secret, controlDir: controlDir(), knownHosts, identityFile });
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env[SECRET_ENV];
	if (secret) Object.assign(env, { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', [SECRET_ENV]: secret });
	return { target: parsed, args: [...opts, destination(parsed)], env };
}

export function remoteProject(projectPath: string | null): (Project & { remote: ProjectRemote }) | undefined {
	const project = listProjects().find((p) => p.path === projectPath);
	return project?.remote ? (project as Project & { remote: ProjectRemote }) : undefined;
}

// A remote session's connection: its own host, with its project's auth.
export function sessionConnection(session: DeckSession): RemoteConn {
	if (!session.remote) throw new Error('not a remote session');
	const projectPath = projectForPath(session.cwd) ?? session.cwd;
	const remote = remoteProject(projectPath)?.remote ?? { target: session.remote.target, path: session.remote.path, auth: { kind: 'default' } };
	return connectionFor(projectPath, remote, session.remote.target);
}

interface RunOptions {
	input?: string;
	maxBuffer?: number;
	timeout?: number;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, opts: RunOptions = {}): Promise<{ stdout: Buffer; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			cmd,
			args,
			{ env, encoding: 'buffer', maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, timeout: opts.timeout ?? 120_000 },
			(err, stdout, stderr) => {
				if (err) reject(Object.assign(err, { stdout: stdout.toString(), stderr: stderr.toString() }));
				else resolve({ stdout, stderr: stderr.toString() });
			}
		);
		child.stdin?.end(opts.input ?? '');
	});
}

// Run a POSIX shell script on the host and return its raw stdout. A failure
// throws with ssh's reason when it was the connection, else the script's
// stderr; `code` carries the exit status.
export async function runRemoteRaw(conn: RemoteConn, script: string, opts: RunOptions = {}): Promise<Buffer> {
	try {
		return (await run('ssh', ['-T', ...conn.args, remoteCommand(script)], conn.env, opts)).stdout;
	} catch (e) {
		const err = e as Error & { stderr?: string; code?: number | string };
		const stderr = err.stderr ?? '';
		const code = typeof err.code === 'number' ? err.code : null;
		throw Object.assign(new Error(sshFailure(stderr, code, conn.target.host) ?? (stderr.trim() || err.message)), { stderr, code });
	}
}

export async function runRemote(conn: RemoteConn, script: string, opts: RunOptions = {}): Promise<string> {
	return (await runRemoteRaw(conn, script, opts)).toString();
}

// A checkout on the host, for git.ts to run its commands in.
export function remoteRepo(conn: RemoteConn, path: string) {
	return { run: (script: string, opts?: RunOptions) => runRemote(conn, script, opts), path };
}

// A stop's kill runs in the background; the session's next start waits for
// it, or the late kill would find and end the new claude.
const pendingKills = new Map<string, Promise<unknown>>();

// Start claude on the session's host with stdio over `ssh -T`.
export async function spawnRemoteClaude(session: DeckSession, args: string[]): Promise<ChildProcess> {
	await pendingKills.get(session.id);
	const conn = sessionConnection(session);
	const script = claudeScript({ id: session.id, path: session.remote!.path, args });
	return spawnAgent('ssh', ['-T', ...conn.args, remoteCommand(script)], { env: conn.env, stdio: ['pipe', 'pipe', 'pipe'] });
}

// End the session's claude on the host by pid; killing the local ssh alone can
// leave it running.
export function killRemoteClaude(session: DeckSession) {
	const kill = Promise.resolve(pendingKills.get(session.id))
		.then(() => runRemote(sessionConnection(session), killScript(session.id), { timeout: 30_000 }))
		.catch((e: Error) => console.error(`[deck] remote stop failed for ${session.id}: ${e.message}`))
		.finally(() => {
			if (pendingKills.get(session.id) === kill) pendingKills.delete(session.id);
		});
	pendingKills.set(session.id, kill);
}

// The local tmux pane command for a remote project's shell session: a tmux on
// the host named for the session, reattached after a dropped connection, so
// the remote shell outlives it. The connection is opened first so the pane
// reuses the master socket; once that expires, a reconnect asks for the
// password or passphrase in the terminal.
export async function remoteShellCommand(projectPath: string, remote: ProjectRemote, id: string): Promise<string> {
	const conn = connectionFor(projectPath, remote);
	await runRemote(conn, 'true', { timeout: 30_000 });
	const tmux = `cd ${shellQuote(remote.path)} 2>/dev/null; exec tmux new -A -s ${shellQuote(`deck-${id}`)}`;
	const ssh = shellJoin(['ssh', '-t', ...conn.args, remoteCommand(tmux)]);
	return `while :; do ${ssh}; printf '\\n[deck] Disconnected. Press Enter to reconnect, Ctrl-C to close.\\n'; read _ || break; done`;
}

// --- host key trust ---------------------------------------------------------

export type HostKeyStatus = 'default' | 'trusted' | 'unknown';

function hostPattern(t: SshTarget): string {
	return t.port && t.port !== 22 ? `[${t.host}]:${t.port}` : t.host;
}

export async function hostKeyStatus(remote: ProjectRemote): Promise<HostKeyStatus> {
	if (remote.auth.kind === 'default') return 'default';
	const t = parseTarget(remote.target)!;
	if (!fs.existsSync(knownHosts)) return 'unknown';
	try {
		await run('ssh-keygen', ['-F', hostPattern(t), '-f', knownHosts], process.env);
		return 'trusted';
	} catch {
		return 'unknown';
	}
}

export interface HostKey {
	type: string;
	fingerprint: string;
}

async function scan(remote: ProjectRemote): Promise<{ lines: string; keys: HostKey[] }> {
	const t = parseTarget(remote.target)!;
	const args = ['-T', '10', ...(t.port ? ['-p', String(t.port)] : []), '--', t.host];
	let lines: string;
	try {
		lines = (await run('ssh-keyscan', args, process.env, { timeout: 30_000 })).stdout.toString();
	} catch (e) {
		lines = (e as { stdout?: string }).stdout ?? '';
	}
	lines = lines.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n');
	if (!lines) throw new Error(`could not read a host key from ${t.host}${t.port ? `:${t.port}` : ''}`);
	const { stdout } = await run('ssh-keygen', ['-lf', '-'], process.env, { input: lines + '\n' });
	const keys = stdout
		.toString()
		.split('\n')
		.map((l) => /^\d+\s+(\S+)\s+.*\(([^)]+)\)\s*$/.exec(l.trim()))
		.filter((m): m is RegExpExecArray => !!m)
		.map((m) => ({ fingerprint: m[1], type: m[2] }));
	return { lines, keys };
}

export async function scanHostKeys(remote: ProjectRemote): Promise<HostKey[]> {
	return (await scan(remote)).keys;
}

// Trust the host's keys, but only the ones the person saw: a fresh scan must
// show exactly the fingerprints they accepted.
export async function acceptHostKeys(remote: ProjectRemote, fingerprints: string[]): Promise<boolean> {
	const { lines, keys } = await scan(remote);
	const seen = new Set(keys.map((k) => k.fingerprint));
	if (seen.size !== new Set(fingerprints).size || !fingerprints.every((f) => seen.has(f))) return false;
	const t = parseTarget(remote.target)!;
	ensureFiles();
	if (fs.existsSync(knownHosts)) await run('ssh-keygen', ['-R', hostPattern(t), '-f', knownHosts], process.env).catch(() => {});
	fs.appendFileSync(knownHosts, lines + '\n', { mode: 0o600 });
	return true;
}
