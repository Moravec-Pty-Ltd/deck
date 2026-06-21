import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PaneStatus } from './devservers-core';

const exec = promisify(execFile);

export interface TmuxSession {
	name: string;
	created: number;
	activity: number;
	attached: boolean;
	windows: number;
	cwd: string;
}

async function tmux(...args: string[]): Promise<string> {
	const { stdout } = await exec('tmux', args);
	return stdout;
}

// Last non-empty render per pane. capture-pane only sees tmux's live screen plus
// scrollback, both of which a program can erase: dev servers (vite, esbuild, bun)
// emit ESC[3J on every rebuild to wipe scrollback, and full-screen TUIs sit on
// the alternate screen. Right after such a clear the capture is blank even though
// the process is alive, so a still-running server reads as dead. Kept on
// globalThis so it survives dev-server HMR. Evicted when the session is killed.
const g = globalThis as { __deckPaneBuf?: Map<string, string> };
const paneBuf = (g.__deckPaneBuf ??= new Map<string, string>());

export async function listTmuxSessions(): Promise<TmuxSession[]> {
	try {
		const out = await tmux(
			'list-sessions',
			'-F',
			'#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}\t#{session_windows}\t#{pane_current_path}'
		);
		return out
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [name, created, activity, attached, windows, cwd] = line.split('\t');
				return {
					name,
					created: Number(created) * 1000,
					activity: Number(activity) * 1000,
					attached: attached !== '0',
					windows: Number(windows),
					cwd: cwd ?? ''
				};
			});
	} catch {
		return []; // no tmux server running
	}
}

export async function createTmuxSession(name: string, cwd: string, command?: string) {
	const args = ['new-session', '-d', '-s', name, '-c', cwd];
	if (command) args.push(command);
	await tmux(...args);
}

// A dev-server pane (issue #32). remain-on-exit (a window option, so -w and the
// `name:` window target) keeps the pane after the command exits, so its exit
// status (running vs errored vs clean stop) and final output stay readable until
// deck kills it. Best-effort: a command that exits before the option is set just
// loses the dead-pane capture, which reads as a clean teardown.
export async function createDevPane(name: string, cwd: string, command: string) {
	await tmux('new-session', '-d', '-s', name, '-c', cwd, command);
	try {
		await tmux('set-option', '-w', '-t', `=${name}:`, 'remain-on-exit', 'on');
	} catch {
		// window already gone (insta-exit) — nothing to keep alive
	}
}

// Liveness + exit status of a dev pane, or null if the tmux session is gone.
// PaneStatus is owned by devservers-core (the pure module that consumes it). The
// has-session guard matters: display-message doesn't error on a missing target
// (it falls back to a current session and returns empty fields), so an absent
// server would otherwise read as a live, never-ready pane.
export async function paneStatus(name: string): Promise<PaneStatus | null> {
	if (!(await hasTmuxSession(name))) return null;
	try {
		const out = await tmux(
			'display-message',
			'-p',
			'-t',
			`=${name}:`,
			'#{pane_dead}\t#{pane_dead_status}\t#{session_created}\t#{session_activity}'
		);
		const [dead, status, created, activity] = out.trim().split('\t');
		if (dead !== '0' && dead !== '1') return null; // not a real pane
		return {
			dead: dead === '1',
			exitStatus: status === '' ? null : Number(status),
			created: (Number(created) || 0) * 1000,
			activity: (Number(activity) || 0) * 1000
		};
	} catch {
		return null;
	}
}

export async function killTmuxSession(name: string) {
	paneBuf.delete(name);
	await tmux('kill-session', '-t', `=${name}`);
}

export async function hasTmuxSession(name: string): Promise<boolean> {
	try {
		await tmux('has-session', '-t', `=${name}`);
		return true;
	} catch {
		return false;
	}
}

async function snapshotPane(name: string, lines = 500): Promise<string> {
	// -e keeps SGR escape sequences so the client can render ANSI colors.
	return tmux('capture-pane', '-e', '-p', '-t', `=${name}:`, '-S', `-${lines}`);
}

// FNV-1a tag over a pane snapshot; lets a client skip re-fetching and re-parsing
// output it already holds (the `h`/`unchanged` round-trip). Shared by the
// terminal snapshot and dev-server log endpoints.
export function snapshotTag(text: string, cleared: boolean): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${cleared ? 'c' : 'l'}${(h >>> 0).toString(36)}`;
}

// Capture that tolerates program-side screen/scrollback clears. Returns the live
// capture when there's something on it, otherwise the last non-empty render with
// `cleared: true` so the UI can show the running process's prior output instead of
// a blank pane that looks dead.
export async function stableSnapshot(
	name: string,
	lines = 500
): Promise<{ text: string; cleared: boolean }> {
	const text = (await snapshotPane(name, lines)).replace(/\s+$/, '');
	if (text) {
		paneBuf.set(name, text);
		return { text, cleared: false };
	}
	const prev = paneBuf.get(name);
	return prev ? { text: prev, cleared: true } : { text: '', cleared: false };
}

// key is a tmux key name like 'C-c', 'Escape', 'Up'
export async function sendRawKey(name: string, key: string) {
	await tmux('send-keys', '-t', `=${name}:`, key);
}

export async function sendKeys(name: string, text: string, submit = true) {
	if (text.length > 0) {
		await tmux('send-keys', '-t', `=${name}:`, '-l', '--', text);
	}
	if (submit) {
		await tmux('send-keys', '-t', `=${name}:`, 'Enter');
	}
}
