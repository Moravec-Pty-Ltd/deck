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

// Per-turn agents (pi, codex): each user message spawns a fresh CLI process that
// streams JSONL to completion, parsed by a driver into deck's normalised events.
// Claude keeps its own persistent-process engine in claude.ts.
const drivers: Record<string, AgentDriver> = { pi: piDriver, codex: codexDriver };

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
		env: agentEnv(session.id),
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

	let buf = '';
	child.stdout!.on('data', (chunk: Buffer) => {
		buf += chunk.toString();
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) dispatchLine(line, driver, ctx);
		}
	});
	child.stderr!.on('data', (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-4000);
	});

	child.on('error', (err) => {
		procs.delete(session.id);
		appendEvent(session.id, deckError(`failed to start ${session.kind}: ${err.message}`));
		setStatus(session.id, 'error');
	});

	child.on('exit', (code, signal) => {
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
