// The overseer (issue #233): one long-lived agent session that watches every
// workflow run and steers it through the run endpoints. deck wakes it with a
// short note when a run blocks, errors, or finishes; it reads run and session
// digests, never full transcripts, so it doesn't compact itself away. The engine
// never depends on it: a run keeps going, and keeps its state, with the
// overseer stopped, deleted, or mid-turn.
import fs from 'node:fs';
import path from 'node:path';
import { agentFeed, type AgentFeedEvent } from './agent-feed';
import { agentInterrupt, agentSend, agentTurnRunning } from './agents/dispatch';
import { createSessionFromRequest } from './create-session';
import { getStoredSession } from './store';
import { baseUrl, dataDir } from './config';
import { sessionDigest } from './agent-digest';
import { sessionLastResult } from './transcript';
import { overseerId, setOverseerId } from './workflow-store';
import { lastVisit, runDigest } from './workflow-core';
import type { StepAgent, WorkflowRun } from '$lib/workflows';

export type OverseerEvent = 'blocked' | 'error' | 'done';

const LAST_RESULT_CAP = 1500;

const BRIEF = `You are the overseer for deck's workflow runs. deck runs each dev or review loop as a state machine, one session per phase, and wakes you with a note when a run blocks, a phase errors, or a run finishes. Each note carries the run digest and the current phase session's digest.

Act through the run API, with curl against $DECK_BASE_URL and the header "Authorization: Bearer $DECK_TOKEN":
- GET  /api/agent/runs, GET /api/agent/runs/<id>
- POST /api/agent/runs/<id>/<action> with JSON. Actions: retry, resume {"phase"}, pause, takeover, cancel, agent {"step","kind","model","effort"}, message {"text"} (only on a paused run), block {"question"}, note, fix-findings (a finished dev run with an open PR and leftover findings: one session fixes them, commits, and pushes).
- GET  /api/agent/sessions/<id> for a phase session's digest and last reply.
Every POST must carry "by":"overseer" and a one-line "reason", so the decision shows on the run.

Rules:
- Never message a review phase session. A reviewer's value is that nobody told it what to think; deck refuses it anyway.
- Never use a blocking ask. When you need a person, POST block {"question"} on the run and move on; deck notifies them.
- Retry a mechanical failure (a crashed turn, a missing structured block) once. Change a step's model when a tier is clearly not converging. Otherwise block with a clear question.
- When a run finishes with leftover findings, say so in your reply. Use fix-findings only when a person asked you to.
- Keep replies short. You are watching, not doing the work.`;

// Notes waiting for the overseer's current turn to end.
const g = globalThis as { __deckOverseerQueue?: string[]; __deckOverseerWired?: boolean };
const queue = (g.__deckOverseerQueue ??= []);

function liveOverseer(): string | undefined {
	const id = overseerId();
	return id && getStoredSession(id) ? id : undefined;
}

function phaseDigest(run: WorkflowRun): unknown {
	const id = lastVisit(run)?.sessionId;
	const session = id ? getStoredSession(id) : undefined;
	if (!session) return null;
	const lastResult = sessionLastResult(session.id)?.slice(-LAST_RESULT_CAP) ?? null;
	return { ...sessionDigest(session), lastResult };
}

function compactRun(run: WorkflowRun): unknown {
	const d = runDigest(run, baseUrl);
	return {
		...d,
		phases: d.phases.map((p) => ({ id: p.id, status: p.status, visits: p.visits, last: p.sessions.at(-1), decisions: p.decisions.slice(-3) }))
	};
}

function noteText(run: WorkflowRun, event: OverseerEvent, detail?: string): string {
	return [
		`Run ${run.id} (${run.title}, ${run.workflowName}): ${event} at ${run.phase}${detail ? `: ${detail}` : ''}.`,
		'```json\n' + JSON.stringify({ run: compactRun(run), phaseSession: phaseDigest(run) }) + '\n```'
	].join('\n');
}

function flush(): void {
	const id = liveOverseer();
	if (!id || !queue.length || agentTurnRunning(id)) return;
	const session = getStoredSession(id)!;
	const text = queue.splice(0).join('\n\n');
	void agentSend(session, text).catch((e) => console.error('[deck] overseer note failed:', e));
}

// Queue a note for the overseer and deliver it when it is free. A no-op when no
// overseer is running.
export function noteOverseer(run: WorkflowRun, event: OverseerEvent, detail?: string): void {
	if (!liveOverseer()) return;
	queue.push(noteText(run, event, detail));
	flush();
}

export function overseerStatus(): { sessionId?: string; active: boolean; busy: boolean } {
	const id = liveOverseer();
	return { sessionId: id, active: !!id, busy: !!id && agentTurnRunning(id) };
}

// Start the overseer, or return the one already running. It works from a
// directory of its own under ~/.deck, outside every project.
// Shared while a start is in flight, so two at once (two tabs) make one.
let starting: Promise<string> | null = null;
// Bumped by stop, so a start that was still spawning doesn't bring the
// overseer back after you stopped it.
let generation = 0;

export function startOverseer(agent: StepAgent = {}): Promise<string> {
	const existing = liveOverseer();
	if (existing) return Promise.resolve(existing);
	if (starting) return starting;
	// Cleared only if still the current start, so a stale one settling late
	// can't drop a newer start in flight.
	const p: Promise<string> = createOverseer(agent).finally(() => {
		if (starting === p) starting = null;
	});
	starting = p;
	return p;
}

async function createOverseer(agent: StepAgent): Promise<string> {
	const gen = generation;
	const cwd = path.join(dataDir, 'overseer');
	fs.mkdirSync(cwd, { recursive: true });
	const session = await createSessionFromRequest(
		{ kind: agent.kind ?? 'claude', model: agent.model, effort: agent.effort, cwd, title: 'Overseer', prompt: BRIEF },
		{ remember: false }
	);
	// Stopped while it spawned: stop its first turn too. The session stays in the
	// list for you to delete, like any stopped overseer's.
	if (gen !== generation) {
		agentInterrupt(session.id);
		throw new Error('the overseer was stopped while it started');
	}
	setOverseerId(session.id);
	return session.id;
}

// Forget the overseer. Its session stays in the list; deleting it is yours.
export function stopOverseer(): void {
	generation += 1;
	starting = null;
	setOverseerId(undefined);
	queue.length = 0;
}

if (!g.__deckOverseerWired) {
	g.__deckOverseerWired = true;
	agentFeed.on('event', (event: AgentFeedEvent) => {
		if (event.type === 'turn-finished' && event.sessionId === overseerId()) flush();
	});
}
