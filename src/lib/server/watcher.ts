// Firing watches (issue #277). Each tick looks for active watches whose due time
// has passed, runs their check once in the session's directory, and sends the
// wake-up message into the session that set them. The pure decisions are
// watch-core.ts; the store and the create / cancel calls are watch-store.ts.
import { spawn } from 'node:child_process';
import { isAgentKind, type DeckSession } from '$lib/types';
import type { Watch, WatchResult } from '$lib/watches';
import { agentTurnRunning } from './agents/dispatch';
import { agentEnv } from './agents/env';
import { resolveWithinProjects } from './confine';
import { getSession } from './sessions';
import { sendAgentMessage } from './send-agent-message';
import { CHECK_TIMEOUT_MS, OUTPUT_CAP, checkAllowed, CHECK_NOT_ALLOWED, isDue, tail, wakeMessage } from './watch-core';
import { cancelSessionWatches, getWatch, listWatches, saveWatch } from './watch-store';

// Run a check command once, killing its whole process group past the limit.
function runCheck(command: string, cwd: string, env: NodeJS.ProcessEnv, limitMs = CHECK_TIMEOUT_MS): Promise<WatchResult> {
	return new Promise((resolve) => {
		let output = '';
		let exitCode: number | null = null;
		let settled = false;
		const finish = (result: WatchResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ...result, output: tail(output) });
		};
		const killGroup = () => {
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				// already gone
			}
		};
		const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const collect = (chunk: Buffer) => {
			// Keep a little over the cap so the tail is still whole after trimming.
			output = (output + chunk.toString('utf8')).slice(-OUTPUT_CAP * 2);
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		child.on('error', (err) => {
			output += err.message;
			finish({ exitCode: null, output });
		});
		// Whatever the check left running in the background goes with it.
		child.on('exit', (code) => {
			exitCode = code;
			killGroup();
		});
		child.on('close', () => finish({ exitCode, output }));
		const timer = setTimeout(() => {
			killGroup();
			// Resolved here rather than on close: a grandchild that escaped the group
			// could hold the pipes open.
			finish({ exitCode, output, timedOut: exitCode === null });
		}, limitMs);
	});
}

async function check(watch: Watch, session: DeckSession): Promise<WatchResult | undefined> {
	if (!watch.command) return undefined;
	// Asked again at fire time: the session's permission mode can change after the watch is set.
	if (!checkAllowed(session)) return { exitCode: null, output: `not run: ${CHECK_NOT_ALLOWED}` };
	const cwd = resolveWithinProjects(session.cwd);
	if (!cwd) return { exitCode: null, output: "not run: the session's directory is outside deck's registered projects" };
	return runCheck(watch.command, cwd, agentEnv(session.id, cwd));
}

// The watch stays active through its check, so it can still be cancelled and a
// restart mid-check runs it again rather than losing the wake-up. The poll is
// single-flight, so no second pass can start the same check meanwhile.
async function fire(watch: Watch, session: DeckSession): Promise<void> {
	// A check that cannot even start (a NUL in the command) still wakes the agent.
	const result = await check(watch, session).catch(
		(e): WatchResult => ({ exitCode: null, output: `not run: ${e instanceof Error ? e.message : String(e)}` })
	);
	const current = getWatch(watch.id);
	if (current?.state !== 'active') return;
	// A turn started during the check: try again after it, so the result is fresh.
	if (agentTurnRunning(session.id)) return;
	const fired: Watch = { ...current, result, state: 'fired', endedAt: Date.now() };
	saveWatch(fired);
	try {
		await sendAgentMessage(session, { text: wakeMessage(fired) });
	} catch (e) {
		console.error(`[deck] watch ${watch.id} could not wake ${session.id}:`, e);
	}
}

let polling = false;

// One pass over the due watches, hung on its own timer in monitor.ts. A watch
// that fell due while deck was down is simply due on the first pass.
export async function pollWatches(): Promise<void> {
	if (polling) return;
	polling = true;
	try {
		const now = Date.now();
		const fires: Promise<void>[] = [];
		// One wake-up per session per pass; a second due watch waits for that turn to end.
		const woken = new Set<string>();
		for (const watch of listWatches()) {
			if (!isDue(watch, now)) continue;
			const session = await getSession(watch.sessionId);
			if (!session || !isAgentKind(session.kind)) {
				cancelSessionWatches(watch.sessionId);
				continue;
			}
			// The whole fire waits for the turn to end, so the check result is fresh
			// and the agent is never interrupted.
			if (woken.has(session.id) || agentTurnRunning(session.id)) continue;
			// Re-read: it may have been cancelled while getSession awaited.
			const current = getWatch(watch.id);
			if (current?.state !== 'active') continue;
			woken.add(session.id);
			fires.push(fire(current, session));
		}
		await Promise.all(fires);
	} finally {
		polling = false;
	}
}
