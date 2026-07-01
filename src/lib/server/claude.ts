import { type ChildProcess } from 'node:child_process';
// cross-spawn so the `claude` CLI also resolves when installed as a Windows
// .cmd/.bat shim, which node:child_process.spawn can't launch directly.
import spawn from 'cross-spawn';
import { EventEmitter } from 'node:events';
import { appendLine, whenDrained } from './transcript-writer';
import { persistImage } from './images';
import { getStoredSession, setSessionStatus, updateSession } from './store';
import { ensureMcp, mcpUrl } from './mcp';
import { rejectAsk } from './ask';
import { notify } from './push';
import { transcriptPath } from './transcript';
import { agentEnv } from './agents/env';
import { lastPrLink } from '../pr';

// Reading the stored transcript (snapshot tail + lazy back-scroll ranges) lives
// in ./transcript, which serves bounded slices off a per-session line index
// instead of re-parsing the whole file on each connect.
export { snapshotFrames, readTranscriptRange } from './transcript';

// Questions go through deck's blocking MCP `ask` tool instead of the built-in
// AskUserQuestion, which the headless CLI can only auto-dismiss.
const ASK_PROMPT =
	'To ask the user a question, call the `mcp__deck__ask` tool (same schema as AskUserQuestion: a `questions` array of { question, header, multiSelect, options:[{label, description}] }). It blocks until the user answers in the deck UI. The built-in AskUserQuestion tool is disabled here.';

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

export function isTurnRunning(id: string) {
	return procs.get(id)?.running ?? false;
}

// Emit on the bus from a deferred continuation. A throwing listener must not
// escape the .finally chains below (it would surface as an unhandled rejection,
// where the old synchronous emit threw into a catchable caller frame); log it.
function emit(channel: string, payload: unknown) {
	try {
		bus.emit(channel, payload);
	} catch (err) {
		console.error(`[deck] bus emit failed (${channel}):`, err);
	}
}
export function appendEvent(id: string, event: Record<string, unknown>) {
	// Persist off the event loop (no more blocking appendFileSync), then emit only
	// once the write settles. Emitting after the write keeps the live bus
	// consistent with the on-disk snapshot a (re)connecting client reads first:
	// anything a subscriber has seen is already durable, so a fresh snapshot can't
	// miss it. A write that fails still emits, so live clients aren't starved.
	const serialized = JSON.stringify(event);
	appendLine(transcriptPath(id), serialized + '\n')
		.catch((err) => console.error(`[deck] transcript append failed for ${id}:`, err))
		.finally(() => emit(`event:${id}`, event));
	capturePr(id, serialized);
}

// Capture the most recent GitHub PR link an agent prints. This is the shared
// write chokepoint for every agent kind (claude's handleEvent and the pi/codex
// runner both land here), so one hook covers all of them. Scans the whole
// serialized event (assistant text, tool results, user messages, tool inputs)
// since the ask is "any PR link, last seen wins". Only writes when the URL
// differs from the stored one, so the hot append path doesn't rewrite
// sessions.json per event.
function capturePr(id: string, serialized: string) {
	const match = lastPrLink(serialized);
	if (!match) return;
	const session = getStoredSession(id);
	if (!session || session.pr?.url === match.url) return;
	updateSession(id, { pr: { ...match, seenAt: Date.now() } });
}

export function setStatus(id: string, status: 'running' | 'idle' | 'error') {
	setSessionStatus(id, status, Date.now());
	// The store update above applies immediately (in memory, and flushed for the
	// terminal idle/error states), so a (re)connecting client reads the right
	// status. Defer only the live emit behind this session's pending transcript
	// writes: appendEvent emits its event after the write settles, so a caller
	// doing appendEvent(x) then setStatus(y) keeps event-before-status order on
	// the bus (e.g. the result footer lands before the spinner clears).
	whenDrained(transcriptPath(id)).finally(() => emit(`status:${id}`, status));
}

// Record the user's answer to a question on the transcript so the UI can show
// the picked options (and mark it answered) on reload, independent of the MCP
// tool_result that unblocks the turn.
export function recordAnswer(id: string, toolUseId: string, answers: unknown) {
	appendEvent(id, { type: 'deck.answer', answersFor: toolUseId, answers, ts: Date.now() });
}

// Push a notification when a turn finishes. Skip quick turns the user is almost
// certainly watching; flag non-success endings (interrupt, error, max turns).
function notifyTurnEnd(id: string, event: Record<string, unknown>) {
	const duration = typeof event.duration_ms === 'number' ? event.duration_ms : 0;
	if (duration && duration < 12000) return;
	const title = getStoredSession(id)?.title ?? id;
	const subtype = event.subtype as string | undefined;
	notify({
		title:
			subtype && subtype !== 'success'
				? `Turn ended (${subtype}) · ${title}`
				: `Claude finished · ${title}`,
		body: 'Tap to open the session',
		tag: id,
		url: `/s/${id}`
	});
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

	// Replace the built-in question tool with deck's blocking MCP one, and allow
	// it through without a permission prompt (which headless mode can't answer).
	args.push(
		'--disallowedTools', 'AskUserQuestion',
		'--allowedTools', 'mcp__deck__ask',
		'--append-system-prompt', ASK_PROMPT,
		'--mcp-config', JSON.stringify({ mcpServers: { deck: { type: 'http', url: mcpUrl(id) } } })
	);

	const child = spawn('claude', args, {
		cwd: session.cwd,
		env: agentEnv(id),
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
		rejectAsk(id, 'process exited');
		if (proc.running && code !== 0) {
			const text = proc.stderrTail.trim() || `claude exited with code ${code}`;
			appendEvent(id, { type: 'deck.error', text, ts: Date.now() });
			setStatus(id, 'error');
			notify({
				title: `Session crashed · ${getStoredSession(id)?.title ?? id}`,
				body: text.split('\n').pop() || 'claude exited unexpectedly',
				tag: id,
				url: `/s/${id}`
			});
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

type EventHandler = (id: string, proc: Proc, event: Record<string, unknown>) => boolean;

// hook / status / thinking-token chatter is high-volume noise we drop.
const NOISE_SYSTEM_SUBTYPES = new Set(['status', 'thinking_tokens']);
function isSystemNoise(subtype: string | undefined): boolean {
	if (!subtype) return false;
	return subtype.startsWith('hook') || NOISE_SYSTEM_SUBTYPES.has(subtype);
}

// Record the resumable session id off the init event; drop system noise.
function handleSystemEvent(id: string, _proc: Proc, event: Record<string, unknown>): boolean {
	if (event.type !== 'system') return false;
	const subtype = event.subtype as string | undefined;
	if (subtype === 'init' && typeof event.session_id === 'string') {
		updateSession(id, { claudeSessionId: event.session_id });
	}
	return isSystemNoise(subtype);
}

// Live partial deltas: emit for streaming display, never persist.
function handleStreamEvent(id: string, proc: Proc, event: Record<string, unknown>): boolean {
	if (event.type !== 'stream_event') return false;
	const ev = event.event as { type?: string } | undefined;
	if (ev?.type === 'message_start') {
		proc.running = true;
		setStatus(id, 'running');
	}
	bus.emit(`event:${id}`, event);
	return true;
}

// Rate-limit and control-response chatter is dropped silently.
function isIgnoredEvent(_id: string, _proc: Proc, event: Record<string, unknown>): boolean {
	return event.type === 'rate_limit_event' || event.type === 'control_response';
}

// Our own replayed user messages echo back; skip them, but keep tool_result turns.
function isReplayedUserEcho(_id: string, _proc: Proc, event: Record<string, unknown>): boolean {
	if (event.type !== 'user') return false;
	const content = (event.message as { content?: unknown })?.content;
	return !(Array.isArray(content) && content.some((b: { type?: string }) => b.type === 'tool_result'));
}

// Turn ended (including a user interrupt → error_during_execution). The process
// is alive and ready, so the session is idle, not errored; the result footer
// still shows the subtype. Hard failures surface on exit.
function handleResult(id: string, proc: Proc, event: Record<string, unknown>): boolean {
	if (event.type !== 'result') return false;
	proc.running = false;
	appendEvent(id, event);
	setStatus(id, 'idle');
	rejectAsk(id, 'turn ended');
	scheduleIdleTeardown(id, proc);
	notifyTurnEnd(id, event);
	return true;
}

const EVENT_HANDLERS: EventHandler[] = [
	handleSystemEvent,
	handleStreamEvent,
	isIgnoredEvent,
	isReplayedUserEcho,
	handleResult
];

function handleEvent(id: string, proc: Proc, event: Record<string, unknown>) {
	for (const handle of EVENT_HANDLERS) {
		if (handle(id, proc, event)) return;
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

export interface ImageInput {
	media_type: string;
	data: string;
}

export interface SendMeta {
	// Marks this message as the answer to an AskUserQuestion tool_use id.
	answersFor?: string;
	answers?: { header: string; labels: string[] }[];
}

// Send a user message, optionally with image attachments. Starts the process if
// needed; queues if a turn is running.
export async function sendMessage(id: string, text: string, images?: ImageInput[], meta?: SendMeta) {
	const session = getStoredSession(id);
	if (!session || session.kind !== 'claude') throw new Error('not a claude session');
	await ensureMcp(); // the MCP server must be listening before the process spawns
	const proc = ensureProcess(id);
	if (proc.idleTimer) clearTimeout(proc.idleTimer);
	const hasImages = !!images && images.length > 0;
	// Persist attachments out-of-band; the transcript keeps only file references so
	// the JSONL (and every full re-parse of it) stays small. The CLI still gets the
	// base64 inline below since that's how stream-json carries image content.
	appendEvent(id, {
		type: 'deck.user',
		text,
		images: hasImages ? images!.map((im) => persistImage(id, im.media_type, im.data)) : undefined,
		answersFor: meta?.answersFor,
		answers: meta?.answers,
		ts: Date.now()
	});
	proc.running = true;
	setStatus(id, 'running');
	const content: unknown = hasImages
		? [
				...(text ? [{ type: 'text', text }] : []),
				...images!.map((im) => ({
					type: 'image',
					source: { type: 'base64', media_type: im.media_type, data: im.data }
				}))
			]
		: text;
	proc.child.stdin!.write(
		JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
	);
}

// Stop the current turn but keep the session alive (control_request interrupt).
export function interrupt(id: string) {
	const proc = procs.get(id);
	if (!proc) return;
	rejectAsk(id, 'interrupted');
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
