import type { ProjectRemote, RemoteAuth } from '$lib/types';

// Pure pieces of running a project's claude sessions on another host over SSH
// (issue #410): validating the project setting, building the ssh argv and the
// remote shell scripts, and turning ssh's stderr into a reason a person can act
// on. No node imports, so the web client shares the setup prompt and the note.

export interface SshTarget {
	user?: string;
	host: string;
	port?: number;
}

// user@host[:port]. The host must start with a letter, digit or `[` so it can't
// be read as an ssh option.
const TARGET_RE = /^(?:([A-Za-z0-9._][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/;

export function parseTarget(target: string): SshTarget | null {
	const m = TARGET_RE.exec(target);
	if (!m) return null;
	const port = m[3] ? Number(m[3]) : undefined;
	if (port !== undefined && (port < 1 || port > 65535)) return null;
	return { user: m[1], host: m[2].replace(/^\[|\]$/g, ''), port };
}

// What ssh takes as the destination: user@host, the port goes in -p.
export function destination(t: SshTarget): string {
	return t.user ? `${t.user}@${t.host}` : t.host;
}

function absolutePosix(p: unknown): p is string {
	return typeof p === 'string' && p.startsWith('/') && !/[\0\n\r]/.test(p);
}

function parseAuth(raw: unknown): RemoteAuth {
	const o = (raw ?? { kind: 'default' }) as Record<string, unknown>;
	if (o.kind === 'default' || o.kind === 'password') return { kind: o.kind };
	if (o.kind === 'key') {
		if (typeof o.identityFile !== 'string' || !o.identityFile.trim()) throw new Error('remote.auth.identityFile is required for key auth');
		return { kind: 'key', identityFile: o.identityFile.trim() };
	}
	throw new Error('remote.auth.kind must be default, key or password');
}

// The PATCH/POST `remote` field: undefined keeps, null clears, an object is
// checked and replaces. A bad value throws, which the route turns into a 400.
export function parseProjectRemote(raw: unknown, existing: ProjectRemote | undefined): ProjectRemote | undefined {
	if (raw === undefined) return existing;
	if (raw === null) return undefined;
	if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('remote must be an object or null');
	const o = raw as Record<string, unknown>;
	const target = typeof o.target === 'string' ? o.target.trim() : '';
	if (!parseTarget(target)) throw new Error('remote.target must look like user@host or user@host:port');
	const path = typeof o.path === 'string' ? o.path.trim().replace(/(.)\/+$/, '$1') : '';
	if (!absolutePosix(path)) throw new Error('remote.path must be an absolute path on the host');
	const auth = parseAuth(o.auth);
	if (auth.kind === 'password' && !parseTarget(target)!.user) throw new Error('password auth needs a user in remote.target');
	return { target, path, auth };
}

// Single-quote for a POSIX shell.
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: string[]): string {
	return argv.map(shellQuote).join(' ');
}

export interface SshOptionInput {
	auth: RemoteAuth;
	port?: number;
	// A password or key passphrase is stored, so askpass supplies it.
	hasSecret: boolean;
	controlDir: string;
	knownHosts: string;
	// The resolved key file for key auth (checked to sit in ~/.ssh).
	identityFile?: string;
}

// ssh options shared by every connection to a project's host. One ControlMaster
// socket per host keeps the secret to one use per connection and spares each
// git or ls call a new handshake.
export function sshOptions(input: SshOptionInput): string[] {
	const opts = [
		'-o', 'ControlMaster=auto',
		'-o', `ControlPath="${input.controlDir}/%C"`,
		'-o', 'ControlPersist=600',
		'-o', 'ConnectTimeout=10',
		'-o', 'ServerAliveInterval=15',
		'-o', 'ServerAliveCountMax=3'
	];
	if (input.port) opts.push('-p', String(input.port));
	const { auth } = input;
	// `default` is the deck host's own ssh config, known hosts included.
	if (auth.kind !== 'default') {
		// Quoted: ssh splits this option's value on spaces.
		opts.push('-o', `UserKnownHostsFile="${input.knownHosts}"`, '-o', 'StrictHostKeyChecking=yes');
	}
	if (auth.kind === 'key') {
		opts.push('-i', input.identityFile ?? auth.identityFile, '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey');
	}
	if (auth.kind === 'password') {
		opts.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no');
	}
	// BatchMode turns askpass off, so only when there is no secret to hand over.
	if (input.hasSecret) opts.push('-o', 'NumberOfPasswordPrompts=1');
	else opts.push('-o', 'BatchMode=yes');
	return opts;
}

// The remote command string ssh runs. Wrapped in `sh -c` so the script runs
// under a POSIX shell with any Bourne-like or fish login shell (not csh).
export function remoteCommand(script: string): string {
	return `sh -c ${shellQuote(script)}`;
}

const ID_RE = /^[a-z0-9_-]+$/;
const PID_DIR = '"$HOME/.deck-remote"';

function pidFile(id: string): string {
	if (!ID_RE.test(id)) throw new Error(`unsafe session id: ${id}`);
	return `${PID_DIR}/${id}.pid`;
}

// Kill a pid from a pid file only while it is still a claude, so a stale file
// whose pid was reused can't take another process down.
// /proc first: BusyBox ps (Alpine images) has no -p.
function killIfClaude(signal: string): string {
	return `{ tr '\\0' ' ' 2>/dev/null < "/proc/$p/cmdline" || ps -o args= -p "$p" 2>/dev/null; } | grep -q claude && kill ${signal} "$p" 2>/dev/null`;
}

// TERM the claude in $p, wait up to `grace` seconds for it to go, then KILL:
// the escalation the local stop uses. Returns once it is gone.
function endClaude(grace: number): string {
	return `if ${killIfClaude('-TERM')}; then i=0; while [ $i -lt ${grace} ] && kill -0 "$p" 2>/dev/null; do sleep 1; i=$((i+1)); done; ${killIfClaude('-KILL')}; fi`;
}

const NO_CLAUDE_MARK = 'deck: claude not found';
const NO_PATH_MARK = 'deck: remote path not found';

// Start claude on the host. The shell records its pid and then execs claude,
// so the pid file names claude itself and Stop can kill it by pid. A claude
// still running for this session (left by a dropped connection) is ended
// first, and waited for, so two never share the conversation.
export function claudeScript(input: { id: string; path: string; args: string[] }): string {
	const f = pidFile(input.id);
	return [
		`mkdir -p ${PID_DIR} || exit 1`,
		`f=${f}`,
		`if [ -f "$f" ]; then p=$(cat "$f"); ${endClaude(3)}; fi`,
		`cd ${shellQuote(input.path)} 2>/dev/null || { echo ${shellQuote(`${NO_PATH_MARK}: ${input.path}`)} >&2; exit 1; }`,
		`command -v claude >/dev/null 2>&1 || { echo ${shellQuote(NO_CLAUDE_MARK)} >&2; exit 127; }`,
		'echo $$ > "$f"',
		`exec claude ${shellJoin(input.args)}`
	].join('\n');
}

// End the session's remote claude by its pid file.
export function killScript(id: string, graceSeconds = 3): string {
	const f = pidFile(id);
	return [
		`f=${f}`,
		'[ -f "$f" ] || exit 0',
		'p=$(cat "$f")',
		endClaude(graceSeconds),
		// A claude started during the grace period has written its own pid by now.
		'[ "$(cat "$f" 2>/dev/null)" = "$p" ] && rm -f "$f"',
		'exit 0'
	].join('\n');
}

// A reason for a failed or dropped connection, from ssh's stderr and exit code,
// or undefined when it doesn't look like ssh's doing. ssh exits 255 for its own
// errors; any other code is the remote command's, whose stderr may well say
// "Permission denied" about a file.
export function sshFailure(stderr: string, code: number | null, host: string): string | undefined {
	const last = stderr.trim().split('\n').filter(Boolean).pop() ?? '';
	if (stderr.includes(NO_CLAUDE_MARK)) {
		return `claude is not on the PATH of a non-interactive shell on ${host}. Check that \`which claude\` finds it in a plain \`ssh\` command.`;
	}
	if (stderr.includes(NO_PATH_MARK)) return `${last.replace(/^deck: /, '')} on ${host}.`;
	if (code !== 255) return undefined;
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)) {
		return `The host key for ${host} has changed since it was accepted, so deck refused to connect. Check with whoever runs the host, then accept the new key in the project's Remote settings.`;
	}
	if (/Host key verification failed|No \S+ host key is known/.test(stderr)) {
		return `The host key for ${host} has not been accepted yet. Accept it in the project's Remote settings (with Default auth, connect once with ssh so it is in ~/.ssh/known_hosts).`;
	}
	if (/Permission denied|incorrect passphrase|bad passphrase|Too many authentication failures/i.test(stderr)) {
		return `${host} refused the login: the password or key passphrase is wrong or not saved, or the key is not authorised there.`;
	}
	if (/Could not resolve hostname|Connection refused|timed out|No route to host|Network is unreachable/i.test(stderr)) {
		return `Could not reach ${host}: ${last}`;
	}
	return `The SSH connection to ${host} dropped${last ? `: ${last}` : ''}. Send a message to resume.`;
}

// A password or passphrase as the secret route accepts it, or null.
export function parseSecret(raw: unknown): string | null {
	return typeof raw === 'string' && raw.length > 0 && raw.length <= 4096 && !/[\n\r\0]/.test(raw) ? raw : null;
}

// Fingerprints from an accept request: the strings among them.
export function parseFingerprints(raw: unknown): string[] {
	return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
}

// Lexical join of a relative path under a remote root, or null when it would
// escape (absolute, `..`, NUL or a newline).
export function remoteJoin(root: string, rel: string): string | null {
	if (/[\0\n\r]/.test(rel) || rel.startsWith('/')) return null;
	const parts: string[] = [];
	for (const seg of rel.split('/')) {
		if (!seg || seg === '.') continue;
		if (seg === '..') return null;
		parts.push(seg);
	}
	return parts.length ? `${root.replace(/\/+$/, '')}/${parts.join('/')}` : root;
}

// The first message the "Set up remote" action sends: deck doesn't install
// anything on the host itself, the session does it the way you would by hand.
export const REMOTE_SETUP_PROMPT =
	'This session runs on a remote host. Before we start, check that the working directory holds the project checkout: if it is empty or not a git repository, ask me which repository to clone and clone it here. Then install its dependencies the way its README or lockfile says, and tell me what you did and anything that failed.';

// What remote sessions can't do, said once where the feature would be.
export const REMOTE_OFF_NOTE =
	'Remote sessions cannot reach deck, so questions, watches, file attachments, dev servers, automation runs and Open in editor are off.';
