import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { transcriptsDir } from './config';
import { getStoredSession, updateSession } from './store';

interface Proc {
	child: ChildProcess;
	running: boolean;
	buf: string;
	stderrTail: string;
	reqSeq: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

// One long-lived `claude --input-format stream-json` process per active session.
// Messages are written to stdin (queued if a turn is in flight); interrupt is a
// control_request that ends the current turn but keeps the session alive.
const procs = new Map<string, Proc>();
const IDLE_MS = 20 * 60 * 1000;

// Survives HMR in dev so SSE subscribers and runners share one bus.
const g = globalThis as { __deckBus?: EventEmitter };
export const bus = (g.__deckBus ??= new EventEmitter());
bus.setMaxListeners(200);

export function transcriptPath(id: string) {
	return path.join(transcriptsDir, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
}

export function isTurnRunning(id: string) {
	return procs.get(id)?.running ?? false;
}

export function readTranscript(id: string): unknown[] {
	try {
		return fs
			.readFileSync(transcriptPath(id), 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function appendEvent(id: string, event: Record<string, unknown>) {
	fs.appendFileSync(transcriptPath(id), JSON.stringify(event) + '\n');
	bus.emit(`event:${id}`, event);
}

function setStatus(id: string, status: 'running' | 'idle' | 'error') {
	updateSession(id, { status, lastActiveAt: Date.now() });
	bus.emit(`status:${id}`, status);
}

function startProcess(id: string): Proc {
	const session = getStoredSession(id);
	if (!session || session.kind !== 'claude') throw new Error('not a claude session');

	const args = [
		'--input-format', 'stream-json',
		'--output-format', 'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--replay-user-messages',
		'-p'
	];
	if (session.claudeSessionId) args.push('--resume', session.claudeSessionId);
	if (session.model) args.push('--model', session.model);
	if (session.permissionMode === 'bypassPermissions') {
		args.push('--dangerously-skip-permissions');
	} else {
		args.push('--permission-mode', session.permissionMode ?? 'acceptEdits');
	}

	const child = spawn('claude', args, {
		cwd: session.cwd,
		env: process.env,
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const proc: Proc = { child, running: false, buf: '', stderrTail: '', reqSeq: 0 };
	procs.set(id, proc);

	child.stdout!.on('data', (chunk: Buffer) => {
		proc.buf += chunk.toString();
		let nl;
		while ((nl = proc.buf.indexOf('\n')) >= 0) {
			const line = proc.buf.slice(0, nl).trim();
			proc.buf = proc.buf.slice(nl + 1);
			if (!line) continue;
			try {
				handleEvent(id, proc, JSON.parse(line));
			} catch {
				// non-JSON noise, ignore
			}
		}
	});
	child.stderr!.on('data', (chunk: Buffer) => {
		proc.stderrTail = (proc.stderrTail + chunk.toString()).slice(-4000);
	});
	child.on('exit', (code) => {
		if (proc.idleTimer) clearTimeout(proc.idleTimer);
		procs.delete(id);
		if (proc.running && code !== 0) {
			appendEvent(id, {
				type: 'deck.error',
				text: proc.stderrTail.trim() || `claude exited with code ${code}`,
				ts: Date.now()
			});
			setStatus(id, 'error');
		} else if (proc.running) {
			setStatus(id, 'idle');
		}
	});

	return proc;
}

function scheduleIdleTeardown(id: string, proc: Proc) {
	if (proc.idleTimer) clearTimeout(proc.idleTimer);
	proc.idleTimer = setTimeout(() => {
		if (!proc.running) proc.child.kill('SIGTERM');
	}, IDLE_MS);
}

function handleEvent(id: string, proc: Proc, event: Record<string, unknown>) {
	const type = event.type;
	const subtype = event.subtype as string | undefined;

	if (type === 'system') {
		if (subtype === 'init' && typeof event.session_id === 'string') {
			updateSession(id, { claudeSessionId: event.session_id });
		}
		// hook / status / thinking-token chatter is high-volume noise
		if (subtype && (subtype.startsWith('hook') || subtype === 'status' || subtype === 'thinking_tokens')) {
			return;
		}
	}

	// Live partial deltas: emit for streaming display, never persist.
	if (type === 'stream_event') {
		const ev = event.event as { type?: string } | undefined;
		if (ev?.type === 'message_start') {
			proc.running = true;
			setStatus(id, 'running');
		}
		bus.emit(`event:${id}`, event);
		return;
	}

	if (type === 'rate_limit_event' || type === 'control_response') return;

	// Skip replayed user messages (our own echo); keep tool_result turns.
	if (type === 'user') {
		const content = (event.message as { content?: unknown })?.content;
		const hasToolResult =
			Array.isArray(content) && content.some((b: { type?: string }) => b.type === 'tool_result');
		if (!hasToolResult) return;
	}

	if (type === 'result') {
		// Turn ended (including a user interrupt → error_during_execution). The
		// process is alive and ready, so the session is idle, not errored; the
		// result footer still shows the subtype. Hard failures surface on exit.
		proc.running = false;
		appendEvent(id, event);
		setStatus(id, 'idle');
		scheduleIdleTeardown(id, proc);
		return;
	}

	appendEvent(id, event);
}

function ensureProcess(id: string): Proc {
	let proc = procs.get(id);
	if (!proc || proc.child.exitCode !== null || proc.child.killed) {
		proc = startProcess(id);
	}
	return proc;
}

// Send a user message. Starts the process if needed; queues if a turn is running.
export function sendMessage(id: string, text: string) {
	const session = getStoredSession(id);
	if (!session || session.kind !== 'claude') throw new Error('not a claude session');
	const proc = ensureProcess(id);
	if (proc.idleTimer) clearTimeout(proc.idleTimer);
	appendEvent(id, { type: 'deck.user', text, ts: Date.now() });
	proc.running = true;
	setStatus(id, 'running');
	proc.child.stdin!.write(
		JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
	);
}

// Stop the current turn but keep the session alive (control_request interrupt).
export function interrupt(id: string) {
	const proc = procs.get(id);
	if (!proc) return;
	proc.reqSeq += 1;
	proc.child.stdin!.write(
		JSON.stringify({
			type: 'control_request',
			request_id: `deck-${proc.reqSeq}`,
			request: { subtype: 'interrupt' }
		}) + '\n'
	);
}

// Hard-stop the process entirely (used on session deletion).
export function stopProcess(id: string) {
	procs.get(id)?.child.kill('SIGTERM');
}
