import type { ChildProcess } from 'node:child_process';
// cross-spawn so pi/codex resolve when installed as Windows .cmd/.bat shims.
import spawn from 'cross-spawn';
import type { DeckSession } from '$lib/types';
import { appendEvent, setStatus, bus } from '../claude';
import { getStoredSession, updateSession } from '../store';
import { notify } from '../push';
import { agentEnv } from './env';
import { deckError, resultEvent } from './events';
import type { AgentDriver, TurnContext } from './types';
import { piDriver } from './pi';
import { codexDriver } from './codex';
import { opencodeDriver } from './opencode';
import { describeLimit, silenceLimitMs, startSilenceWatchdog } from './watchdog-core';

// Per-turn agents (pi, codex, opencode): each user message spawns a fresh CLI
// process that streams JSONL to completion, parsed by a driver into deck's
// normalised events. Claude keeps its own persistent-process engine in claude.ts.
const drivers: Record<string, AgentDriver> = { pi: piDriver, codex: codexDriver, opencode: opencodeDriver };

const g = globalThis as { __deckAgentProcs?: Map<string, ChildProcess> };
const procs = (g.__deckAgentProcs ??= new Map());

export function turnRunning(id: string): boolean {
	return procs.has(id);
}

export function interruptTurn(id: string) {
	procs.get(id)?.kill('SIGTERM');
}

function agentTitle(id: string): string {
	const stored = getStoredSession(id);
	return stored ? stored.title : id;
}

function dispatchLine(raw: string, driver: AgentDriver, ctx: TurnContext) {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return; // log noise interleaved with the JSONL
	}
	try {
		driver.handleLine(parsed, ctx);
	} catch {
		// a malformed event shouldn't kill the stream
	}
}

function isCrash(sawResult: boolean, code: number | null, signal: string | null): boolean {
	if (sawResult) return false;
	if (signal === 'SIGTERM') return false;
	return code !== 0;
}

export async function runTurn(session: DeckSession, text: string) {
	const driver = drivers[session.kind];
	if (!driver) throw new Error(`no agent driver for ${session.kind}`);

	// One turn at a time: a new message interrupts any in-flight turn (resume
	// picks up whatever the agent already committed to its session/thread).
	procs.get(session.id)?.kill('SIGTERM');

	appendEvent(session.id, { type: 'deck.user', text, ts: Date.now() });
	setStatus(session.id, 'running');

	const started = Date.now();
	const turn = driver.buildTurn(session, text, session.agentSessionId);
	const child = spawn(turn.cmd, turn.args, {
		cwd: session.cwd,
		env: agentEnv(session.id, session.cwd),
		stdio: ['pipe', 'pipe', 'pipe']
	});
	procs.set(session.id, child);

	let sawResult = false;
	let stderrTail = '';
	const ctx: TurnContext = {
		append: (event) => {
			if (event.type === 'result') sawResult = true;
			appendEvent(session.id, event);
		},
		emit: (event) => bus.emit(`event:${session.id}`, event),
		setAgentSessionId: (agentId) => updateSession(session.id, { agentSessionId: agentId })
	};

	// A CLI that hangs without exiting never reaches the exit handler below, so
	// the crash path has to be driven by silence instead (see watchdog-core).
	const limitMs = silenceLimitMs(process.env);
	const watchdog = startSilenceWatchdog(limitMs, () => {
		// Superseded: a newer turn owns the session now, and runTurn already
		// signalled this child, so it has nothing left to say.
		if (procs.get(session.id) !== child) return;
		// Drop the registry entry here rather than waiting for an exit that may
		// never come: while it is present `turnRunning` re-derives the session as
		// running and masks the status set below.
		procs.delete(session.id);
		child.kill('SIGTERM');
		if (sawResult) {
			// The turn itself finished and only the process is wedged. `isCrash`
			// treats a seen result as authoritative; so does this.
			setStatus(session.id, 'idle');
			notifyTurnEnd(session.id, Date.now() - started, false);
			return;
		}
		const why = `no output from ${session.kind} for ${describeLimit(limitMs)}; stopped the stalled turn`;
		const tail = stderrTail.trim();
		reportCrash(session.id, session.kind, tail ? `${tail}\n${why}` : why);
	});

	let buf = '';
	child.stdout!.on('data', (chunk: Buffer) => {
		// Bytes already in flight when a child is superseded or killed still drain
		// to us. Dropping them here is what keeps a dead turn's trailing events,
		// footer, and agent session id out of the turn that replaced it.
		if (procs.get(session.id) !== child) return;
		watchdog.bump();
		buf += chunk.toString();
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) dispatchLine(line, driver, ctx);
		}
	});
	child.stderr!.on('data', (chunk: Buffer) => {
		if (procs.get(session.id) !== child) return;
		// stderr counts as liveness too: an agent that logs progress there and
		// nothing to stdout is working, not stalled.
		watchdog.bump();
		stderrTail = (stderrTail + chunk.toString()).slice(-4000);
	});

	child.on('error', (err) => {
		watchdog.stop();
		if (procs.get(session.id) !== child) return;
		procs.delete(session.id);
		appendEvent(session.id, deckError(`failed to start ${session.kind}: ${err.message}`));
		setStatus(session.id, 'error');
	});

	child.on('exit', (code, signal) => {
		watchdog.stop();
		// A superseded child can exit long after the message that replaced it; it
		// must not report a footer or a status over the top of the live turn.
		if (procs.get(session.id) !== child) return;
		procs.delete(session.id);
		if (isCrash(sawResult, code, signal)) {
			reportCrash(session.id, session.kind, stderrTail.trim() || `${session.kind} exited (${code})`);
			return;
		}
		// Synthesize a turn footer if the driver didn't emit one (clean exit / kill).
		if (!sawResult) appendEvent(session.id, resultEvent());
		setStatus(session.id, 'idle');
		notifyTurnEnd(session.id, Date.now() - started, signal === 'SIGTERM');
	});

	child.stdin!.end(turn.stdin ?? '');
}

function reportCrash(id: string, kind: string, text: string) {
	appendEvent(id, deckError(text));
	setStatus(id, 'error');
	notify({
		title: `Session crashed · ${agentTitle(id)}`,
		body: text.split('\n').pop() || `${kind} exited unexpectedly`,
		tag: id,
		url: `/s/${id}`
	});
}

function notifyTurnEnd(id: string, durationMs: number, interrupted: boolean) {
	if (interrupted) return;
	if (durationMs < 12000) return;
	notify({
		title: `Finished · ${agentTitle(id)}`,
		body: 'Tap to open the session',
		tag: id,
		url: `/s/${id}`
	});
}
