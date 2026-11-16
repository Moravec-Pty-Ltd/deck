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
import { runRemote, sessionConnection } from './remote';
import { shellQuote } from '$lib/remote-core';
import { getSession } from './sessions';
import { sendAgentMessage } from './send-agent-message';
import { CHECK_TIMEOUT_MS, OUTPUT_CAP, bringForward, checkAllowed, CHECK_NOT_ALLOWED, isDue, tail, waitsForReview, wakeMessage } from './watch-core';
import { activeWatches, cancelSessionWatches, getWatch, listWatches, saveWatch } from './watch-store';

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

// A remote session's check runs in its folder on the host, over its connection.
async function remoteCheck(command: string, session: DeckSession): Promise<WatchResult> {
	// Its own shell, so a check that calls `exit` still reports its code, under
	// the host's `timeout` where there is one: ending the ssh alone leaves it running.
	const secs = Math.ceil(CHECK_TIMEOUT_MS / 1000);
	const check = shellQuote(`cd -- ${shellQuote(session.remote!.path)} && ${command}\n`);
	const script = `t=; command -v timeout >/dev/null 2>&1 && t="timeout ${secs}"; $t sh -c ${check} 2>&1; echo "${EXIT_MARK}$?"`;
	try {
		const out = await runRemote(sessionConnection(session), script, { timeout: CHECK_TIMEOUT_MS + 5000 });
		const at = out.lastIndexOf(EXIT_MARK);
		if (at < 0) return { exitCode: null, output: tail(out) };
		const exitCode = Number(out.slice(at + EXIT_MARK.length));
		// timeout's own code for a check it stopped.
		return { exitCode, output: tail(out.slice(0, at)), ...(exitCode === 124 ? { timedOut: true } : {}) };
	} catch (e) {
		return { exitCode: null, output: (e as Error).message };
	}
}
const EXIT_MARK = 'deck-check-exit:';

async function check(watch: Watch, session: DeckSession): Promise<WatchResult | undefined> {
	if (!watch.command) return undefined;
	// Asked again at fire time: the session's permission mode can change after the watch is set.
	if (!checkAllowed(session)) return { exitCode: null, output: `not run: ${CHECK_NOT_ALLOWED}` };
	if (session.remote) return remoteCheck(watch.command, session);
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

// One pass over the due watches, hung on its own timer in monitor.ts. A watch
// that fell due while deck was down is simply due on the first pass.
async function pass(): Promise<void> {
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
}

let inflight: Promise<void> | null = null;
let again = false;

// Single-flight: a call during a pass shares it, and the pass runs once more at
// its end so a watch brought forward meanwhile does not wait for the next tick.
export function pollWatches(): Promise<void> {
	if (inflight) {
		again = true;
		return inflight;
	}
	inflight = (async () => {
		try {
			do {
				again = false;
				await pass();
			} while (again);
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

// Run a watch now: bring it due and poll, so it fires through the normal path
// (its check, one wake per session, never mid-turn). Undefined when unknown.
export function runWatchNow(id: string): Watch | undefined {
	const watch = getWatch(id);
	if (!watch) return undefined;
	const next = bringForward(watch, Date.now());
	if (next !== watch) {
		saveWatch(next);
		void pollWatches().catch(() => {});
	}
	return next;
}

// A morabot verdict landed on this session's PR (issue #376): run the watches
// waiting for that review now. The session's other watches keep their time.
export function runReviewWatches(sessionId: string, review: { repo: string; pr: number }): void {
	for (const w of activeWatches(sessionId)) if (waitsForReview(w, review)) runWatchNow(w.id);
}
