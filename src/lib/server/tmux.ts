import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

export async function killTmuxSession(name: string) {
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

export async function snapshotPane(name: string, lines = 500): Promise<string> {
	// -e keeps SGR escape sequences so the client can render ANSI colors.
	return tmux('capture-pane', '-e', '-p', '-t', `=${name}:`, '-S', `-${lines}`);
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
