import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { DeckSession, Workflow, WorkflowRun, WorkflowStep } from '$lib/types';
import { expandPlaceholders, type PlaceholderContext } from '$lib/placeholders';
import {
	capOutput,
	expandStepTokens,
	isLegacyWorkflowId,
	nextAfter,
	resolveWorkflows,
	retryPrompt,
	runStepsSnapshot,
	shellQuote
} from '$lib/workflows-core';
import { appendEvent, bus, stopProcess } from './claude';
import { agentInterrupt, agentSend } from './agents/dispatch';
import { getStoredSession, listProjects, updateSession } from './store';
import { projectForPath, resolveWithinProjects } from './confine';
import { notify } from './push';
import { publishAgentEvent } from './agent-feed';
import type { AskQuestion, PendingAsk } from './ask';

// The workflow runner (issue #111): drives one run per session through its
// steps. run/gate commands execute in the session cwd; agent steps are turns
// in the session (the transcript stays unified); ask steps block on the deck
// ask UI. Start/cancel use the epoch/supersede guard pattern from
// devservers.ts: every await re-checks the epoch and bails without writes once
// it moved, so a cancel or a replacing start can't race a stale continuation.

interface ActiveRun {
	epoch: number;
	// the run/gate child currently executing, so cancel can kill it
	child?: ChildProcess;
	// resolves the pending ask step, so cancel (or /answer) can settle it;
	// askId pins /answer to this exact checkpoint, not a stale card's.
	// questions/askedAt are kept for the agent API's pending-asks listing.
	ask?: {
		askId: string;
		questions: AskQuestion[];
		askedAt: number;
		resolve: (text: string) => void;
		reject: (err: Error) => void;
	};
	// set by noteInterrupt when the user interrupts the in-flight agent turn,
	// so the step reads as failed (pausing the run) instead of advancing on
	// half-done work.
	interrupted?: boolean;
}

const g = globalThis as { __deckWorkflowRuns?: Map<string, ActiveRun> };
const runs = (g.__deckWorkflowRuns ??= new Map());

export function runActive(id: string): boolean {
	return runs.has(id);
}

// The user interrupted this session's turn (the composer's Interrupt button);
// a workflow agent step in flight must not advance past it.
export function noteInterrupt(id: string): void {
	const inst = runs.get(id);
	if (inst) inst.interrupted = true;
}

// Resolve `workflowId` against the project owning `cwd` (a worktree maps back
// to its registered project). Shared by the create-session and run-here
// routes. The legacy synthesized pair is the plain new-session path, never a
// startable run, so those ids resolve to nothing here.
export function workflowForPath(cwd: string, workflowId: string): Workflow | undefined {
	if (isLegacyWorkflowId(workflowId)) return undefined;
	const project = listProjects().find((p) => p.path === projectForPath(cwd));
	return resolveWorkflows(project).find((w) => w.id === workflowId);
}

// Ask-step ids carry this prefix; /answer resolves a checkpoint only on an
// exact askId match (see resolveWorkflowAsk).
const WORKFLOW_ASK_PREFIX = 'wfask-';

// Whether the session is blocked on a workflow ask step. Kept apart from
// ask.ts's map: that one is tied to the claude process lifecycle (interrupt /
// turn end / process exit all reject it), while a workflow checkpoint must
// survive an idle process teardown and works for every agent kind.
export function workflowAskPending(id: string): boolean {
	return !!runs.get(id)?.ask;
}

// Every session's pending workflow checkpoint, for the agent API's
// needs-attention listing. `askId` must ride along: /answer resolves a
// checkpoint only on an exact askId match.
export function listWorkflowAsks(): PendingAsk[] {
	return [...runs.entries()]
		.filter(([, inst]) => inst.ask)
		.map(([sessionId, inst]) => ({
			sessionId,
			source: 'workflow' as const,
			askId: inst.ask!.askId,
			questions: inst.ask!.questions,
			askedAt: inst.ask!.askedAt
		}));
}

// The askId of the session's pending workflow checkpoint, or null. Lets /answer
// report an askId-mismatch distinctly from "nothing waiting" (issue #144).
export function workflowAskId(id: string): string | null {
	return runs.get(id)?.ask?.askId ?? null;
}

// Resolve the pending workflow ask with the user's answer text, but only when
// the answer targets that exact checkpoint (a click on a stale ask card, MCP
// or workflow, must not unblock the run with unrelated text). Returns false
// when nothing matching was waiting.
export function resolveWorkflowAsk(id: string, askId: string, text: string): boolean {
	const ask = runs.get(id)?.ask;
	if (!ask || ask.askId !== askId) return false;
	ask.resolve(text);
	return true;
}

// Transcript marker for the progress line in the chat view. Persisted like
// deck.model so the run's shape survives a reload.
function marker(id: string, data: Record<string, unknown>) {
	appendEvent(id, { type: 'deck.workflow', ...data, ts: Date.now() });
}

function persistRun(id: string, run: WorkflowRun) {
	updateSession(id, { workflowRun: run });
	// Every run transition funnels through here (start, step advance, status
	// flips, finish, cancel), so this one tap keeps the agent feed complete.
	publishAgentEvent(id, 'workflow', { workflowRun: run });
}

// Wait for the turn agentSend just started to settle: the next idle/error on
// the session's status channel. agentSend flips the status to running
// synchronously (both engines), so anything that lands after it is this
// turn's terminal state. `cancel` detaches the listener when the send itself
// fails and the promise will never settle.
function waitForTurnEnd(id: string): { promise: Promise<'idle' | 'error'>; cancel: () => void } {
	let onStatus!: (status: unknown) => void;
	const promise = new Promise<'idle' | 'error'>((resolve) => {
		onStatus = (status: unknown) => {
			if (status !== 'idle' && status !== 'error') return;
			bus.off(`status:${id}`, onStatus);
			resolve(status);
		};
		bus.on(`status:${id}`, onStatus);
	});
	return { promise, cancel: () => bus.off(`status:${id}`, onStatus) };
}

// Run a shell command in the session cwd, capturing interleaved stdout+stderr.
// The command comes from the user's own project config (same trust as a
// dev-server run command); the boundary that matters is the cwd, checked
// against the registered project set before the run starts.
function execStep(
	inst: ActiveRun,
	command: string,
	cwd: string
): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
		inst.child = child;
		let output = '';
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-64_000);
		};
		child.stdout!.on('data', collect);
		child.stderr!.on('data', collect);
		child.on('error', (err) => {
			inst.child = undefined;
			resolve({ ok: false, output: `failed to start command: ${err.message}` });
		});
		child.on('exit', (code, signal) => {
			inst.child = undefined;
			if (signal) resolve({ ok: false, output: `${output}\n(killed by ${signal})`.trim() });
			else resolve({ ok: code === 0, output });
		});
	});
}

// Block on a human checkpoint: surface the question on the transcript (the
// chat view renders deck.ask through the same component as the MCP ask) and
// wait for /answer to resolve it. The askId keys the deck.answer marker so
// the answered state persists on reload.
function askStep(
	inst: ActiveRun,
	id: string,
	question: string,
	askId: string,
	title: string
): Promise<{ ok: boolean; output: string }> {
	// One tappable option keeps a plain "ready to proceed?" checkpoint to a
	// single click; the free-text field still takes a custom answer, which
	// lands in [step:<name>] for later steps.
	const questions: AskQuestion[] = [
		{ question, header: 'workflow', options: [{ label: 'Continue' }] }
	];
	appendEvent(id, { type: 'deck.ask', askId, questions, ts: Date.now() });
	notify({
		title: `Needs your answer · ${title}`,
		body: question,
		tag: id,
		url: `/s/${id}`
	});
	publishAgentEvent(id, 'awaiting-input', { awaitingInput: true, source: 'workflow', askId, questions });
	const settled = () => {
		inst.ask = undefined;
		publishAgentEvent(id, 'awaiting-input', { awaitingInput: false, source: 'workflow', askId });
	};
	return new Promise((resolve) => {
		inst.ask = {
			askId,
			questions,
			askedAt: Date.now(),
			resolve: (text) => {
				settled();
				resolve({ ok: true, output: text });
			},
			reject: () => {
				settled();
				resolve({ ok: false, output: 'checkpoint cancelled' });
			}
		};
	});
}

// Apply an agent step's model override through the same plumbing as the
// header model switcher (see the /model route): persist it, drop claude's
// idle process so the next send respawns with the new model, and leave a
// transcript marker. Later steps without an override inherit it.
function applyStepModel(id: string, kind: DeckSession['kind'], model: string | undefined) {
	if (!model) return;
	const stored = getStoredSession(id);
	if (!stored || stored.model === model) return;
	updateSession(id, { model });
	if (kind === 'claude') stopProcess(id);
	appendEvent(id, { type: 'deck.model', model, ts: Date.now() });
}

function isTextBlock(block: { type?: string; text?: unknown }): boolean {
	return block?.type === 'text' && typeof block.text === 'string' && !!block.text.trim();
}

// The result footer's subtype, when the event is one ('success' for a clean
// turn; interrupts and max-turns endings carry other subtypes).
function resultSubtypeIn(event: unknown): string | null {
	const ev = event as { type?: string; subtype?: unknown };
	return ev?.type === 'result' && typeof ev.subtype === 'string' ? ev.subtype : null;
}

// The last non-empty assistant text block an event carries, or null. Feeds the
// agent step's captured output so later steps can reference [step:<name>].
function lastAssistantText(event: unknown): string | null {
	const ev = event as { type?: string; message?: { content?: unknown } };
	const content = ev?.type === 'assistant' ? ev.message?.content : null;
	if (!Array.isArray(content)) return null;
	const texts = content.filter(isTextBlock);
	return texts.length ? (texts[texts.length - 1].text as string) : null;
}

interface RunCtx {
	session: DeckSession;
	workflow: Workflow;
	run: WorkflowRun;
	inst: ActiveRun;
	epoch: number;
	cwd: string; // canonical session cwd, where run/gate commands execute
	ctx: PlaceholderContext;
	outputs: Record<string, string>; // step name → captured output
	attempts: Record<number, number>; // gate step index → retries consumed
	promptOverride?: string; // modal-edited prompt for the first agent step
	retryFeedback?: string; // gate failure prompt for the next agent step
}

function expand(rc: RunCtx, text: string): string {
	return expandStepTokens(expandPlaceholders(text, rc.ctx), rc.outputs);
}

// Expand tokens into a run/gate command with every value single-quoted:
// issue bodies, PR titles, and captured step outputs are remote- or
// model-authored, so they must never be able to smuggle shell syntax. Write
// `--title [issue_title]`, not `--title "[issue_title]"`.
function expandCommand(rc: RunCtx, text: string): string {
	const quote = ([k, v]: [string, string | undefined]) => [k, v === undefined ? v : shellQuote(v)];
	const ctx = Object.fromEntries(Object.entries(rc.ctx).map(quote)) as typeof rc.ctx;
	const outputs = Object.fromEntries(Object.entries(rc.outputs).map(quote)) as typeof rc.outputs;
	return expandStepTokens(expandPlaceholders(text, ctx), outputs);
}

// Execute the step at rc.run.step. Returns ok + captured output; agent output
// is the turn's last assistant text so later steps can reference it.
async function execCurrent(rc: RunCtx): Promise<{ ok: boolean; output: string }> {
	const id = rc.session.id;
	const step = rc.workflow.steps[rc.run.step];
	switch (step.type) {
		case 'run':
		case 'gate':
			return execStep(rc.inst, expandCommand(rc, step.command), rc.cwd);
		case 'ask':
			return askStep(
				rc.inst,
				id,
				expand(rc, step.question),
				`${WORKFLOW_ASK_PREFIX}${rc.run.startedAt}-${rc.run.step}`,
				rc.run.name
			);
		case 'agent':
			return agentStep(rc, step);
	}
}

// A turn advances the run only when it ended cleanly: no user interrupt, an
// idle terminal status, and a successful result footer. Anything else pauses
// the run rather than letting later steps ship half-done work.
function turnOutcome(
	inst: ActiveRun,
	status: 'idle' | 'error',
	subtype: string,
	lastText: string
): { ok: boolean; output: string } {
	if (inst.interrupted) return { ok: false, output: 'turn interrupted by the user' };
	if (status !== 'idle') return { ok: false, output: lastText || 'agent turn errored' };
	if (subtype !== 'success') return { ok: false, output: `turn ended (${subtype})` };
	return { ok: true, output: lastText };
}

// One agent turn. The prompt is, in priority order: the gate-failure feedback
// (a retry), the modal's create-time edit (first agent step only), then the
// configured step prompt. Captures the turn's final assistant text as the
// step output.
async function agentStep(
	rc: RunCtx,
	step: Extract<WorkflowStep, { type: 'agent' }>
): Promise<{ ok: boolean; output: string }> {
	const id = rc.session.id;
	// Retry feedback is sent verbatim (gate output must not be re-expanded);
	// the create-time override and the configured prompt both take [tokens].
	const prompt = rc.retryFeedback ?? expand(rc, rc.promptOverride ?? step.prompt);
	rc.retryFeedback = undefined;
	rc.promptOverride = undefined;
	if (!prompt.trim()) return { ok: false, output: 'agent step has an empty prompt' };

	applyStepModel(id, rc.session.kind, step.model);
	const session = getStoredSession(id);
	if (!session) return { ok: false, output: 'session removed' };

	let lastText = '';
	let subtype = 'success';
	const onEvent = (event: unknown) => {
		lastText = lastAssistantText(event) ?? lastText;
		subtype = resultSubtypeIn(event) ?? subtype;
	};
	rc.inst.interrupted = false;
	bus.on(`event:${id}`, onEvent);
	const ended = waitForTurnEnd(id);
	try {
		await agentSend(session, prompt);
		const status = await ended.promise;
		return turnOutcome(rc.inst, status, subtype, lastText);
	} catch (e) {
		ended.cancel();
		return { ok: false, output: e instanceof Error ? e.message : 'agent send failed' };
	} finally {
		bus.off(`event:${id}`, onEvent);
	}
}

function superseded(rc: RunCtx): boolean {
	return rc.inst.epoch !== rc.epoch;
}

function setRun(rc: RunCtx, patch: Partial<WorkflowRun>) {
	rc.run = { ...rc.run, ...patch };
	persistRun(rc.session.id, rc.run);
}

function finish(rc: RunCtx, status: 'done' | 'paused', reason?: string) {
	setRun(rc, { status, reason });
	runs.delete(rc.session.id);
	marker(rc.session.id, { state: status, reason });
	notify({
		title: `${status === 'done' ? 'Workflow finished' : 'Workflow paused'} · ${rc.session.title}`,
		body: status === 'done' ? rc.run.name : (reason ?? rc.run.name),
		tag: rc.session.id,
		url: `/s/${rc.session.id}`
	});
}

// The sequential drive loop. Every await is followed by a supersede check so a
// cancel (epoch bump) abandons the continuation without another write.
async function drive(rc: RunCtx): Promise<void> {
	const id = rc.session.id;
	for (;;) {
		const step = rc.workflow.steps[rc.run.step];
		marker(id, { state: 'step', step: rc.run.step, name: step.name, stepType: step.type });
		if (step.type === 'ask') setRun(rc, { status: 'awaiting-input' });

		const result = await execCurrent(rc);
		if (superseded(rc)) return;
		if (step.type === 'ask') setRun(rc, { status: 'running' });
		rc.outputs[step.name] = capOutput(result.output, 32_000);

		const next = nextAfter(rc.workflow.steps, rc.run.step, result.ok, rc.attempts);
		if (next.kind === 'done') return finish(rc, 'done');
		if (next.kind === 'pause') return finish(rc, 'paused', next.reason);
		if (next.retry) {
			rc.attempts[next.retry.gate] = next.retry.attempt;
			rc.retryFeedback = retryPrompt(step.name, result.output, next.retry.attempt, next.retry.max);
			marker(id, { state: 'retry', step: next.step, gate: rc.run.step, attempt: next.retry.attempt, max: next.retry.max });
		}
		setRun(rc, { step: next.step });
	}
}

// Start a run on a session. One run per session: a live one is a conflict the
// caller surfaces as a 409. `ctx` carries the create-time placeholder context
// (including the fetched issue detail, which is never persisted); the caller
// builds it from the session when starting on an existing one.
export function startRun(
	session: DeckSession,
	workflow: Workflow,
	ctx: PlaceholderContext,
	promptOverride?: string
): void {
	const id = session.id;
	if (runs.has(id)) throw new Error('a workflow run is already active on this session');
	// run/gate commands execute in the session cwd; keep that inside the
	// registered project set, and run in the canonical path (see confine.ts).
	const cwd = resolveWithinProjects(session.cwd);
	if (!cwd) throw new Error('session cwd is outside the registered project set');

	const inst: ActiveRun = { epoch: 0 };
	runs.set(id, inst);
	const run: WorkflowRun = {
		workflowId: workflow.id,
		name: workflow.name,
		steps: runStepsSnapshot(workflow),
		step: 0,
		status: 'running',
		startedAt: Date.now()
	};
	persistRun(id, run);
	marker(id, { state: 'start', name: workflow.name, steps: run.steps });

	const rc: RunCtx = {
		session,
		workflow,
		run,
		inst,
		epoch: inst.epoch,
		cwd,
		ctx,
		// null-prototype: step names key this map, so a name that slips past
		// validation must not reach Object.prototype (defense in depth)
		outputs: Object.create(null),
		attempts: {},
		promptOverride: promptOverride?.trim() || undefined
	};
	void drive(rc).catch((e) => {
		if (superseded(rc)) return;
		finish(rc, 'paused', e instanceof Error ? e.message : 'workflow runner crashed');
	});
}

// Cancel the active run (kill the in-flight command, settle a pending ask,
// abandon the drive loop) or clear a terminal one from the session.
export function cancelRun(id: string): void {
	const inst = runs.get(id);
	if (inst) {
		inst.epoch++;
		inst.child?.kill('SIGTERM');
		inst.ask?.reject(new Error('cancelled'));
		// Stop an in-flight agent turn too: cancelling the run means stopping
		// everything it started, same as the Interrupt button would.
		agentInterrupt(id);
		runs.delete(id);
		const stored = getStoredSession(id);
		if (stored?.workflowRun) {
			persistRun(id, { ...stored.workflowRun, status: 'cancelled', reason: 'cancelled' });
		}
		marker(id, { state: 'cancelled' });
		return;
	}
	// No live runner: dismiss whatever terminal/stale run state is stored.
	const stored = getStoredSession(id);
	if (stored?.workflowRun) updateSession(id, { workflowRun: undefined });
}
