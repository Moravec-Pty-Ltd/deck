// The workflow engine (issue #233): runs the dev and review loops as a state
// machine the deck server owns, one fresh agent session per phase in the run's
// worktree. The pure transition logic is workflow-core.ts; this file spawns the
// sessions, runs the gates, applies the core's decisions, and takes the
// pause / take-over / resume controls.
//
// Every run carries an epoch, bumped by each control and each phase entry. Any
// work that awaits (a gh call, a verify command, a session spawn) captures the
// epoch first and drops its result if the epoch moved, the same supersede guard
// devservers.ts uses, so a pause or resume can never race a late completion.
import { error } from '@sveltejs/kit';
import { agentFeed, publishAgentEvent, type AgentFeedEvent } from './agent-feed';
import { createSessionFromRequest } from './create-session';
import { forgetTree } from './workflow-api';
import { deleteSession } from './sessions';
import { agentFields } from './automation-core';
import { agentInterrupt, agentSend, agentTurnRunning } from './agents/dispatch';
import { getStoredSession, listProjects, listStoredSessions, updateSession } from './store';
import { hasPendingAsk } from './ask';
import { sessionLastResult } from './transcript';
import { notify } from './push';
import { createWorktree, fetchPullRef, originRepo } from './git';
import { projectForPath, resolveWithinProjects } from './confine';
import { issuePromptContext } from './issues/prompt';
import { slugifyBranch } from './branch-core';
import { lastPrLink } from '$lib/pr';
import { shortIssueId } from '$lib/issues';
import { EFFORT_LEVELS } from '$lib/effort';
import { AGENT_KINDS, type DeckSession, type Project, type SessionIssue } from '$lib/types';
import * as core from './workflow-core';
import * as store from './workflow-store';
import * as wexec from './workflow-exec';
import { noteOverseer } from './workflow-overseer';
import { canFixFindings } from '$lib/workflows';
import type {
	DecisionBy,
	PhaseVisit,
	RunPr,
	StepAgent,
	WorkflowCategory,
	WorkflowDef,
	WorkflowRun,
	WorkflowStep
} from '$lib/workflows';

// ---- Bookkeeping ----

function commit(run: WorkflowRun): void {
	run.updatedAt = Date.now();
	store.saveRun(run);
	// Small on purpose: the event log is shared with every session event, so a
	// client fetches the digest (GET /api/agent/runs/{id}) when it needs it.
	publishAgentEvent(run.id, 'run-updated', { runId: run.id, status: run.status, phase: run.phase, updatedAt: run.updatedAt });
}

function stale(run: WorkflowRun, epoch: number): boolean {
	return store.getRun(run.id) !== run || run.epoch !== epoch;
}

function message(e: unknown): string {
	if (e && typeof e === 'object' && 'body' in e) return String((e as { body: { message?: string } }).body?.message);
	return e instanceof Error ? e.message : String(e);
}

function openVisit(run: WorkflowRun): PhaseVisit | undefined {
	const visit = core.lastVisit(run);
	return visit && !visit.endedAt ? visit : undefined;
}

function projectOf(run: WorkflowRun): Project {
	return listProjects().find((p) => p.path === run.projectPath) ?? { name: '', path: run.projectPath };
}

// ---- Applying the core's decisions ----

// Tell people (and the overseer, unless it made the call) that the run
// stopped or needs someone.
function announce(run: WorkflowRun, by?: DecisionBy): void {
	if (run.status === 'blocked') {
		notify({
			reason: 'needs-you',
			title: `Run blocked · ${run.title}`,
			body: run.block?.question,
			tag: run.id,
			url: `/runs/${run.id}`,
			ask: { runId: run.id, header: run.title, options: [], questions: 1 }
		});
		if (by !== 'overseer') noteOverseer(run, 'blocked');
	}
	if (run.status === 'done') {
		notify({ reason: 'stopped', title: `Run finished · ${run.title}`, tag: run.id, url: `/runs/${run.id}` });
		noteOverseer(run, 'done');
	}
}

async function apply(run: WorkflowRun, effect: core.Effect): Promise<void> {
	if (effect.type === 'enter') return enter(run, effect.step);
	commit(run);
	announce(run);
}

// Feed a finished visit's result to the core, unless the run moved on meanwhile.
async function finish(run: WorkflowRun, epoch: number, result: core.GateResult): Promise<void> {
	if (stale(run, epoch)) return;
	// Claim the result: a second completion racing this one (the turn event and
	// the settle poll, both awaiting a slow gh gate) now reads as stale.
	run.epoch += 1;
	if (result.error) noteOverseer(run, 'error', result.error);
	await apply(run, core.advance(run, result, Date.now()));
}

// ---- Entering a step ----

async function enter(run: WorkflowRun, stepId: string): Promise<void> {
	run.epoch += 1;
	const epoch = run.epoch;
	const step = core.stepById(run, stepId)!;
	const visit = core.beginVisit(run, stepId, Date.now());
	commit(run);
	try {
		await startStep(run, step, visit, epoch);
	} catch (e) {
		await finish(run, epoch, { pass: false, error: message(e) });
	}
}

function startStep(run: WorkflowRun, step: WorkflowStep, visit: PhaseVisit, epoch: number): Promise<void> {
	if (step.role === 'verify') return startVerify(run, step, visit, epoch);
	// The reviewer loop waits on the reviewer; pollRuns starts each round.
	if (step.role === 'feedback') return pollFeedback(run, epoch);
	return startSkill(run, step, visit, epoch);
}

// The verify command in flight per run, so a cancel, block, or resume stops it
// instead of leaving a second test run racing the next one.
const verifying = new Map<string, AbortController>();

async function startVerify(run: WorkflowRun, step: WorkflowStep, visit: PhaseVisit, epoch: number): Promise<void> {
	const command = wexec.verifyCommand(run.cwd, step.command);
	if (!command) return finish(run, epoch, { pass: true, skipped: true, detail: 'no test command found' });
	visit.detail = command;
	commit(run);
	const { code, output } = await trackedVerify(run, command);
	await finish(run, epoch, { pass: code === 0, detail: `${command} exited ${code}`, output });
}

// Run the verify command where a cancel, block, or resume can stop it.
async function trackedVerify(run: WorkflowRun, command: string): Promise<{ code: number; output: string }> {
	const controller = new AbortController();
	verifying.set(run.id, controller);
	return wexec.runVerify(run.cwd, command, controller.signal).finally(() => {
		if (verifying.get(run.id) === controller) verifying.delete(run.id);
	});
}

// A review round's scope: everything the tree changed since the last round saw
// it, hand edits included, from two snapshots rather than the last commit.
async function reviewContext(run: WorkflowRun, visit: PhaseVisit): Promise<core.PromptContext> {
	visit.tree = await wexec.snapshotTree(run.cwd);
	const delta = run.reviewTree && run.round > 0 ? await wexec.deltaBetween(run.cwd, run.reviewTree, visit.tree) : undefined;
	return { delta };
}

function phaseTitle(run: WorkflowRun, step: WorkflowStep, visit: PhaseVisit): string {
	return `${run.title} · ${step.label}${visit.visit > 1 ? ` ${visit.visit}` : ''}`;
}

function sessionBody(run: WorkflowRun, step: WorkflowStep, visit: PhaseVisit): Record<string, unknown> {
	const issue = run.issue ? { issue: run.issue } : {};
	// A review run's session carries its PR, which is what the automatic review
	// cap and the per-PR dedupe count.
	const pr = step.role === 'pr-review' && run.pr ? { pr: run.pr } : {};
	return {
		...agentFields(projectOf(run), visit.agent ?? {}),
		cwd: run.cwd,
		title: phaseTitle(run, step, visit),
		...issue,
		...pr
	};
}

// The issue's own text for the phases that act on it. deck has the credentials
// and the issue already, so fetching here costs one request instead of a tool
// call and a few thousand tokens in every phase that would otherwise go and
// read it. Best effort: a failure comes back as a warning the prompt shows.
async function issueContextFor(run: WorkflowRun, step: WorkflowStep): Promise<core.PromptContext> {
	if (step.role !== 'implement' || !run.issue) return {};
	const picked = { issue: run.issue, sourceId: run.issue.sourceId ?? '' };
	return { issue: await issuePromptContext(run.cwd, [picked]) };
}

async function startSkill(run: WorkflowRun, step: WorkflowStep, visit: PhaseVisit, epoch: number): Promise<void> {
	const ctx = step.role === 'review' ? await reviewContext(run, visit) : {};
	if (stale(run, epoch)) return;
	// Started beside the spawn, not before it: only the prompt needs the issue
	// text, so the session create hides the fetch's latency, and a control
	// landing mid-spawn still sees the same ordering it always did.
	const issue = issueContextFor(run, step);
	// Created idle and sent its prompt here, after the stale check, rather than
	// by the create pipeline: a pause or cancel landing mid-spawn then leaves an
	// idle session, never one that starts editing the worktree untracked.
	const session = await createSessionFromRequest(sessionBody(run, step, visit), { remember: false });
	// Every phase shares the run's worktree; none owns it, so deleting a phase
	// session never takes the branch with it.
	updateSession(session.id, { worktree: { repo: run.projectPath, branch: run.branch, createdBranch: false, base: run.base } });
	// Superseded mid-spawn: the session never got its prompt, so drop it rather
	// than leave an idle stray in the list. Its worktree is the run's, not its own.
	if (stale(run, epoch)) return deleteSession(session.id);
	visit.sessionId = session.id;
	run.status = 'running';
	commit(run);
	// A failed dispatch leaves the session idle with no reply, which the settle
	// poll turns into a retry.
	void issue
		.then((extra) => agentSend(session, core.phasePrompt(run, step, { ...ctx, ...extra })))
		.catch((e) => console.error(`[deck] run ${run.id} dispatch failed:`, e));
}

// ---- Gates on a finished turn ----

type Gate = (run: WorkflowRun, text: string | null) => Promise<core.GateResult>;

const turnGate: Gate = async (_run, text) => {
	if (text === null) return { pass: false, error: 'the phase produced no reply' };
	return { pass: true, structured: core.parseStructured(text) ?? undefined };
};

const findingsGate: Gate = async (_run, text) => {
	const structured = core.parseStructured(text);
	if (!structured?.findings) return { pass: false, error: 'the review ended without its findings block' };
	const blockers = core.blockerCount(structured.findings);
	return { pass: blockers === 0, structured, detail: `${blockers} blockers, ${structured.findings.length} findings` };
};

function toRunPr(pr: NonNullable<Awaited<ReturnType<typeof wexec.prForBranch>>>): RunPr {
	const link = lastPrLink(pr.url);
	return { repo: link?.repo ?? '', number: pr.number, url: pr.url, title: pr.title, baseRefName: pr.baseRefName };
}

// A PR is open for the branch and, for a GitHub issue, closes it. A missing
// link is an error rather than a fail so the PR phase gets its retry.
const prLinkedGate: Gate = async (run) => {
	const pr = await wexec.prForBranch(run);
	if (!pr) return { pass: false, error: 'no PR is open for the branch' };
	run.pr = toRunPr(pr);
	const n = core.githubIssueNumber(run.issue);
	if (n !== null && !pr.closingIssuesReferences.some((r) => r.number === n)) {
		return { pass: false, error: `${pr.url} does not close #${n}` };
	}
	return { pass: true, detail: pr.url };
};

async function reviewView(run: WorkflowRun) {
	if (!run.pr) throw new Error('the run has no PR');
	return wexec.prReviewView(run.cwd, run.pr.repo, run.pr.number);
}

const feedbackGate: Gate = async (run) => {
	const view = await reviewView(run);
	run.feedbackSignature = core.feedbackSignature(view);
	return { pass: core.feedbackTerminal(view), detail: `${view.unresolvedThreads} open threads` };
};

const reviewedGate: Gate = async (run) => {
	const view = await reviewView(run);
	const pass = core.reviewedAtHead(view, await wexec.ghLogin(run.cwd));
	return { pass, detail: pass ? 'reviewed at head' : 'no review of mine at the head' };
};

const GATES: Record<WorkflowStep['gate'], Gate> = {
	turn: turnGate,
	'exit-zero': turnGate,
	'no-blockers': findingsGate,
	'pr-linked': prLinkedGate,
	'pr-approved': feedbackGate,
	'pr-reviewed': reviewedGate
};

// A follow-up fix passes on git and the tests, not on what the session says:
// a new commit on the PR branch, pushed, and green.
const followUpGate: Gate = async (run) => {
	const state = await wexec.pushState(run.cwd, run.followUp!.head);
	const problem = core.followUpProblem(state, run.followUp!.head, run.branch);
	if (problem) return { pass: false, detail: problem };
	const command = wexec.verifyCommand(run.cwd, run.steps.find((s) => s.role === 'verify')?.command);
	const tests = command ? await trackedVerify(run, command) : { code: 0, output: '' };
	if (tests.code !== 0) return { pass: false, detail: `${command} exited ${tests.code} on the pushed commit` };
	return { pass: true, detail: state.head.slice(0, 7) };
};

function gateFor(run: WorkflowRun, step: WorkflowStep): Gate {
	return run.followUp && step.role === 'fix' ? followUpGate : GATES[step.gate];
}

async function evaluate(run: WorkflowRun, step: WorkflowStep, sessionId: string, subtype: string): Promise<core.GateResult> {
	if (subtype === 'error') return { pass: false, error: 'the session errored' };
	if (subtype !== 'success') return { pass: false, error: `the turn ended with ${subtype}` };
	try {
		return await gateFor(run, step)(run, sessionLastResult(sessionId));
	} catch (e) {
		return { pass: false, error: message(e) };
	}
}

function runForSession(sessionId: string): WorkflowRun | undefined {
	return store.listRuns().find((r) => !core.isFinished(r) && openVisit(r)?.sessionId === sessionId);
}

// A phase session's turn ended. Only a running run reacts: a paused one is being
// driven by hand, and a blocked one is waiting on a person.
async function onTurnEnd(sessionId: string, subtype: string): Promise<void> {
	const run = runForSession(sessionId);
	if (run?.status === 'paused') return notePausedEnd(run, subtype);
	if (!run || run.status !== 'running') return;
	const step = core.currentStep(run)!;
	const epoch = run.epoch;
	const result = await evaluate(run, step, sessionId, subtype);
	// A pause landed while the gate ran: keep the turn for the resume to settle.
	// (re-read: the await may have changed it)
	if (store.getRun(run.id)?.status === 'paused' && openVisit(run)?.sessionId === sessionId) return notePausedEnd(run, subtype);
	await finish(run, epoch, result);
}

// A plain pause leaves the agent working. If its turn ends meanwhile, keep how
// it ended so resuming the same phase settles that turn instead of re-running a
// phase that already finished. A taken-over session is yours: its turns are
// not the agent's verdict.
function notePausedEnd(run: WorkflowRun, subtype: string): void {
	const visit = openVisit(run);
	if (!visit || visit.humanTouched) return;
	visit.pausedEnd = subtype;
	commit(run);
}

async function onSessionGone(sessionId: string): Promise<void> {
	const run = runForSession(sessionId);
	if (!run || run.status !== 'running') return;
	await finish(run, run.epoch, { pass: false, error: 'the phase session was deleted' });
}

function onFeedEvent(event: AgentFeedEvent): void {
	const go = (p: Promise<void>) => void p.catch((e) => console.error('[deck] workflow event failed:', e));
	if (event.type === 'turn-finished') go(onTurnEnd(event.sessionId, String(event.subtype ?? 'success')));
	else if (event.type === 'status' && event.status === 'error') go(onTurnEnd(event.sessionId, 'error'));
	else if (event.type === 'session-deleted') go(onSessionGone(event.sessionId));
}

// ---- The reviewer loop and the safety net, on the monitor's gh tick ----

async function startFeedbackRound(run: WorkflowRun, epoch: number): Promise<void> {
	// Claim the round: the enter path and a monitor tick can both get here for
	// one run, and only the first may start a session.
	if (stale(run, epoch) || run.status !== 'waiting') return;
	run.epoch += 1;
	epoch = run.epoch;
	const step = core.currentStep(run)!;
	const visit = openVisit(run) ?? core.beginVisit(run, step.id, Date.now());
	// The round starts now, not when the wait began: the settle grace counts from here.
	visit.startedAt = Date.now();
	run.status = 'running';
	commit(run);
	// Off the enter path, so a failed spawn is settled here or the run would sit
	// `running` with a sessionless visit nothing ever settles.
	await startSkill(run, step, visit, epoch).catch((e) => finish(run, epoch, { pass: false, error: message(e) }));
}

async function pollFeedback(run: WorkflowRun, epoch: number): Promise<void> {
	const view = await reviewView(run);
	if (stale(run, epoch)) return;
	if (core.feedbackTerminal(view)) return finish(run, epoch, { pass: true, detail: 'approved' });
	if (core.feedbackDue(view, run.feedbackSignature)) return startFeedbackRound(run, epoch);
}

// A skill visit whose session went idle without its turn-finished event reaching
// us (the event raced a restart, or the first turn never dispatched) is settled
// from what the session last said, after a grace period.
const SETTLE_GRACE_MS = 90_000;

// The open visit's session and how its turn ended, when it needs settling.
function settlingSession(run: WorkflowRun, now: number): string | null {
	const visit = openVisit(run);
	if (run.status !== 'running' || !visit?.sessionId) return null;
	return now - visit.startedAt < SETTLE_GRACE_MS ? null : visit.sessionId;
}

function busy(session: DeckSession): boolean {
	return agentTurnRunning(session.id) || hasPendingAsk(session.id) || session.status === 'running';
}

function needsSettling(run: WorkflowRun, now: number): { id: string; ended: 'gone' | 'error' | 'success' } | null {
	const id = settlingSession(run, now);
	const session = id ? getStoredSession(id) : undefined;
	if (!id) return null;
	if (!session) return { id, ended: 'gone' };
	if (busy(session)) return null;
	return { id, ended: session.status === 'error' ? 'error' : 'success' };
}

async function pollRun(run: WorkflowRun): Promise<void> {
	if (run.status === 'waiting') return pollFeedback(run, run.epoch);
	const settle = needsSettling(run, Date.now());
	if (!settle) return;
	return settle.ended === 'gone' ? onSessionGone(settle.id) : onTurnEnd(settle.id, settle.ended);
}

// Runs with a poll in flight. Per run, so one run's long transition (a settle
// that goes on to a 20-minute verify) never holds up the others.
const polling = new Set<string>();

function pollDetached(run: WorkflowRun): Promise<void> {
	polling.add(run.id);
	return pollRun(run)
		.catch((e) => console.error(`[deck] run ${run.id} poll failed:`, e))
		.finally(() => polling.delete(run.id));
}

// Resolves once every poll started by this tick has finished.
export async function pollRuns(): Promise<void> {
	const due = store.listRuns().filter((r) => !core.isFinished(r) && !polling.has(r.id));
	await Promise.all(due.map(pollDetached));
}

// ---- Restart recovery ----

const RESUME_NOTE = 'deck restarted while this phase was running. Carry on with the same task from where you left off.';

// A run that was mid-phase when deck stopped picks up where it was: a phase
// session is told to carry on (its agent resumes its own conversation), and a
// review round, a command, or a spawn that never finished is started again.
// The phase session to tell to carry on, if any. A reviewer is never told
// anything, so an interrupted review round starts over in a fresh session.
function resumableSession(run: WorkflowRun, visit: PhaseVisit | undefined) {
	const role = core.currentStep(run)?.role;
	if (role === 'review' || role === 'pr-review' || !visit?.sessionId) return undefined;
	return getStoredSession(visit.sessionId);
}

async function recoverRun(run: WorkflowRun): Promise<void> {
	if (run.status !== 'running') return;
	const visit = openVisit(run);
	const session = resumableSession(run, visit);
	if (session) {
		run.decisions.push({ at: Date.now(), by: 'engine', step: run.phase, action: 'recover', reason: 'deck restarted mid-phase; the phase session was told to carry on.' });
		commit(run);
		await agentSend(session, RESUME_NOTE);
		return;
	}
	if (visit) Object.assign(visit, { endedAt: Date.now(), result: 'interrupted', detail: 'deck restarted' });
	await enter(run, run.phase);
}

export function recoverRuns(): void {
	for (const run of store.listRuns()) {
		void recoverRun(run).catch((e) => console.error(`[deck] run ${run.id} recovery failed:`, e));
	}
}

// ---- Starting a run ----

export interface StartRunRequest {
	cwd: string;
	workflow?: string;
	category?: WorkflowCategory;
	issue?: SessionIssue;
	pr?: RunPr;
	base?: string;
	title?: string;
}

function activeIn(cwd: string): WorkflowRun | undefined {
	return store.listRuns().find((r) => !core.isFinished(r) && resolveWithinProjects(r.cwd) === cwd);
}

// A new issue branch, or the existing one when the issue was run before.
async function issueWorktree(repo: string, branch: string, base: string | undefined): Promise<string> {
	try {
		return (await createWorktree(repo, branch, { newBranch: true, base })).dir;
	} catch {
		return (await createWorktree(repo, branch, { newBranch: false })).dir;
	}
}

interface Placement {
	cwd: string;
	branch: string;
	base?: string;
}

// Where the run works: the worktree it was started in, a fresh worktree on the
// issue's branch, or the PR's head checked out for review.
// A run never works in the main checkout itself: started anywhere inside it,
// it gets a worktree like one started at the root.
async function placeRun(project: Project, req: StartRunRequest, real: string, base: string | undefined): Promise<Placement> {
	const root = resolveWithinProjects(project.path)!;
	const top = real === root ? root : await wexec.toplevel(real);
	// A review run checks its PR out itself; started inside some worktree it
	// would review whatever that worktree had checked out.
	if (top !== root && req.pr) error(400, 'start a review run from the project, not a worktree');
	if (top !== root) return { cwd: top, branch: await wexec.currentBranch(top), base };
	if (req.pr) return prPlacement(root, req.pr, base);
	if (!req.issue) error(400, 'a run needs an issue, a PR, or a worktree to start in');
	const branch = slugifyBranch(req.issue.id);
	if (!branch) error(400, 'the issue id makes no usable branch name');
	return { cwd: await issueWorktree(root, branch, base), branch, base };
}

// A plain review session (one no run spawned) that works in a worktree. Moving
// the checkout under it is not ours to do, so a run refuses the PR instead.
// A plain session working in `dir` right now. An idle one (a review that
// finished) doesn't hold it: reviews don't edit, so refreshing under it is safe.
function heldByReviewSession(dir: string): boolean {
	const spawned = new Set(store.listRuns().flatMap((r) => r.visits.map((v) => v.sessionId)));
	return listStoredSessions().some((s) => !spawned.has(s.id) && busy(s) && (resolveWithinProjects(s.cwd) ?? s.cwd) === dir);
}

// An existing pr/<n> ref may predate the PR's latest push: refresh its checkout
// before the run reads it, unless a run or a plain session still works there.
async function refreshPrWorktree(dir: string, pr: RunPr): Promise<void> {
	if (activeIn(resolveWithinProjects(dir) ?? dir)) error(409, 'a run is already active in that worktree');
	if (heldByReviewSession(dir)) error(409, `a review session already holds the worktree for PR #${pr.number}`);
	await wexec.syncPullWorktree(dir, pr.number);
}

async function prPlacement(root: string, pr: RunPr, base: string | undefined): Promise<Placement> {
	const { branch, created } = await fetchPullRef(root, pr.number);
	const wt = await createWorktree(root, branch, { newBranch: false });
	if (!created && wt.branch === branch) await refreshPrWorktree(wt.dir, pr);
	return { cwd: wt.dir, branch: wt.branch, base: pr.baseRefName ?? base };
}

function startTitle(req: StartRunRequest, branch: string): string {
	if (req.title) return req.title;
	if (req.issue) return shortIssueId(req.issue.source, req.issue.id);
	return req.pr ? `PR #${req.pr.number}` : branch;
}

// A review workflow reviews a PR; a dev workflow starts from an issue.
function assertFits(def: WorkflowDef, req: StartRunRequest): void {
	if (def.category === 'review' && !req.pr) error(400, 'a review workflow needs a pr');
	if (def.category === 'dev' && req.pr) error(400, 'a dev workflow starts from an issue, not a pr');
}

function resolveStart(req: StartRunRequest) {
	const category = req.category ?? (req.pr ? 'review' : 'dev');
	const def = core.pickWorkflow(store.loadWorkflows().workflows, { id: req.workflow, category });
	if (!def) error(400, req.workflow ? `no workflow "${req.workflow}"` : 'no default workflow for that category');
	assertFits(def, req);
	const real = resolveWithinProjects(req.cwd);
	const projectPath = real === null ? null : projectForPath(real);
	if (real === null || projectPath === null) error(403, 'cwd must be within the registered project set');
	return { def, real, project: listProjects().find((p) => p.path === projectPath)! };
}

export async function startRun(req: StartRunRequest): Promise<WorkflowRun> {
	const { def, real, project } = resolveStart(req);
	const origin = await originRepo(project.path).catch(() => null);
	const mismatch = core.repoMismatch(origin, req.pr);
	if (mismatch) error(400, mismatch);
	const owner = origin?.split('/')[0];
	const profile = core.matchProfile(store.loadProfiles(), { owner, issue: req.issue });
	const base = req.base || profile.baseBranch || project.lastBase || undefined;
	if (activeIn(real)) error(409, 'a run is already active in that worktree');
	const place = await placeRun(project, req, real, base);
	if (activeIn(resolveWithinProjects(place.cwd) ?? place.cwd)) error(409, 'a run is already active in that worktree');
	const run = core.newRun({
		id: `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
		def,
		projectPath: project.path,
		...place,
		title: startTitle(req, place.branch),
		issue: req.issue,
		pr: req.pr,
		profile,
		now: Date.now()
	});
	store.saveRun(run);
	await enter(run, run.phase);
	return run;
}

// ---- Controls ----

const RUN_ACTIONS = ['pause', 'takeover', 'resume', 'retry', 'cancel', 'answer', 'block', 'agent', 'note', 'handoff', 'message', 'fix-findings'] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

interface Actor {
	by: DecisionBy;
	reason: string;
}

type Handler = (run: WorkflowRun, body: Record<string, unknown>, actor: Actor) => Promise<void>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function record(run: WorkflowRun, actor: Actor, action: string, step = run.phase): void {
	run.decisions.push({ at: Date.now(), by: actor.by, step, action, reason: actor.reason });
}

function assertLive(run: WorkflowRun): void {
	if (core.isFinished(run)) error(409, `the run is ${run.status}`);
}

// End the open visit and stop its session's turn, so a resume or retry never
// leaves two agents editing one worktree. Pause alone doesn't call this: a
// take-over needs the session left for you to drive.
function closeOpen(run: WorkflowRun, detail: string): void {
	const visit = openVisit(run);
	if (!visit) return;
	Object.assign(visit, { endedAt: Date.now(), result: 'interrupted', detail });
	if (visit.sessionId) agentInterrupt(visit.sessionId);
	verifying.get(run.id)?.abort();
}

function pauseRun(run: WorkflowRun, actor: Actor): void {
	assertLive(run);
	run.epoch += 1;
	run.status = 'paused';
	record(run, actor, 'pause');
	commit(run);
}

// A blocked run is already stopped; pausing it would only hide its question
// from the ask listings. Take it over instead.
const pause: Handler = async (run, _body, actor) => {
	if (run.status === 'blocked') error(409, 'the run is blocked: answer it, resume it, or take it over');
	pauseRun(run, actor);
};

// Take over: pause, stop the phase session's turn so you can drive it, and flag
// the phase. The next review round's scope comes from tree snapshots, so the
// hand edits are in it.
const takeover: Handler = async (run, _body, actor) => {
	pauseRun(run, actor);
	const visit = openVisit(run) ?? core.lastVisit(run);
	if (visit) Object.assign(visit, { humanTouched: true, pausedEnd: undefined });
	run.humanTouched = true;
	verifying.get(run.id)?.abort();
	if (visit?.sessionId) agentInterrupt(visit.sessionId);
	record(run, actor, 'takeover');
	commit(run);
};

// The open visit's turn ended while the run was paused; settle it now.
async function settlePausedEnd(run: WorkflowRun, visit: PhaseVisit): Promise<void> {
	// A gate's verify may still be running from before the pause.
	verifying.get(run.id)?.abort();
	run.status = 'running';
	run.epoch += 1;
	const epoch = run.epoch;
	await finish(run, epoch, await evaluate(run, core.currentStep(run)!, visit.sessionId!, visit.pausedEnd!));
}

// The paused visit whose ended turn a resume of `phase` should settle.
function pausedEndFor(run: WorkflowRun, phase: string): PhaseVisit | undefined {
	const visit = openVisit(run);
	return run.status === 'paused' && phase === run.phase && visit?.pausedEnd ? visit : undefined;
}

// Clear what a fresh start of `phase` must not inherit: the block, red test
// output meant for an earlier fix, and every failure counter for the phase
// (verify's red streak included), so a resume is not a fourth attempt.
function freshStart(run: WorkflowRun, phase: string): void {
	// A follow-up lives only on the fix step; resuming anywhere else returns
	// the run to its normal loop, so a later fix round is a normal one.
	if (core.stepById(run, phase)?.role !== 'fix') {
		run.verifyOutput = undefined;
		run.followUp = undefined;
	}
	run.block = undefined;
	run.error = undefined;
	for (const key of Object.keys(run.failures)) if (key === phase || key.startsWith(`${phase}#`)) run.failures[key] = 0;
}

const resume: Handler = async (run, body, actor) => {
	assertLive(run);
	const phase = str(body.phase) || run.phase;
	if (!core.stepById(run, phase)) error(400, `the workflow has no step "${phase}"`);
	record(run, actor, 'resume', phase);
	const paused = pausedEndFor(run, phase);
	if (paused) return settlePausedEnd(run, paused);
	closeOpen(run, 'resumed elsewhere');
	freshStart(run, phase);
	await enter(run, phase);
};

// Run the current phase again from scratch, even if its turn already ended.
const retry: Handler = async (run, _body, actor) => {
	assertLive(run);
	record(run, actor, 'retry');
	closeOpen(run, 'retried');
	freshStart(run, run.phase);
	await enter(run, run.phase);
};

const cancel: Handler = async (run, _body, actor) => {
	assertLive(run);
	closeOpen(run, 'cancelled');
	run.epoch += 1;
	run.status = 'cancelled';
	run.followUp = undefined;
	run.block = undefined;
	record(run, actor, 'cancel');
	commit(run);
};

const answer: Handler = async (run, body, actor) => {
	if (run.status !== 'blocked') error(409, 'the run is not waiting on an answer');
	const text = str(body.text);
	if (!text) error(400, 'text is required');
	run.answers.push({ text, at: Date.now() });
	await resume(run, {}, { ...actor, reason: actor.reason || text });
};

// Block the run on a question for a person. The overseer's way to ask: it never
// waits on an answer itself.
const block: Handler = async (run, body, actor) => {
	assertLive(run);
	const question = str(body.question);
	if (!question) error(400, 'question is required');
	run.epoch += 1;
	closeOpen(run, 'blocked');
	core.blockRun(run, run.phase, question, Date.now(), actor.by);
	record(run, actor, 'block');
	commit(run);
	announce(run, actor.by);
};

function oneOf(v: unknown, allowed: readonly string[], what: string): string | undefined {
	const s = str(v);
	if (s && !allowed.includes(s)) error(400, `invalid ${what}`);
	return s || undefined;
}

// The override, or undefined when every field is blank (which clears it).
function pickAgent(body: Record<string, unknown>): StepAgent | undefined {
	const agent = {
		kind: oneOf(body.kind, AGENT_KINDS, 'kind'),
		model: str(body.model) || undefined,
		provider: str(body.provider) || undefined,
		effort: oneOf(body.effort, EFFORT_LEVELS, 'effort')
	} as StepAgent;
	return Object.values(agent).some(Boolean) ? agent : undefined;
}

const setAgent: Handler = async (run, body, actor) => {
	const step = str(body.step) || run.phase;
	if (!core.stepById(run, step)) error(400, `the workflow has no step "${step}"`);
	const { [step]: _old, ...rest } = run.stepAgents ?? {};
	const agent = pickAgent(body);
	run.stepAgents = agent ? { ...rest, [step]: agent } : rest;
	record(run, actor, 'agent', step);
	commit(run);
};

const note: Handler = async (run, _body, actor) => {
	record(run, actor, 'note');
	commit(run);
};

// The driver's intent, stamped with the tree it was written against.
const handoff: Handler = async (run, body, actor) => {
	const text = str(body.text);
	if (!text) error(400, 'text is required');
	run.handoff = { text, tree: await wexec.snapshotTree(run.cwd), at: Date.now() };
	record(run, actor, 'handoff');
	commit(run);
};

// Steer the current phase session of a paused run. Review phases are refused:
// a reviewer's value is that nobody told it what to think. A running run is
// refused too: the message would queue behind the turn and run after the
// engine had already moved on to the next phase.
function steerable(run: WorkflowRun): DeckSession {
	const role = core.currentStep(run)?.role;
	if (role === 'review' || role === 'pr-review') error(409, 'review phases are never steered');
	if (run.status !== 'paused') error(409, 'pause or take over the run before messaging its phase session');
	const id = openVisit(run)?.sessionId;
	const session = id ? getStoredSession(id) : undefined;
	if (!session || agentTurnRunning(session.id)) error(409, 'the phase session is busy or gone');
	return session;
}

const sendMessage: Handler = async (run, body, actor) => {
	const text = str(body.text);
	if (!text) error(400, 'text is required');
	const session = steerable(run);
	record(run, actor, 'message');
	commit(run);
	void agentSend(session, text).catch((e) => console.error(`[deck] run ${run.id} message failed:`, e));
};

function fixableStep(run: WorkflowRun): WorkflowStep {
	if (!canFixFindings(run)) error(409, 'only a finished dev run with an open PR and leftover findings can fix them');
	const fix = run.steps.find((s) => s.role === 'fix');
	if (!fix) error(409, 'the workflow has no fix step');
	const other = activeIn(resolveWithinProjects(run.cwd) ?? run.cwd);
	if (other) error(409, 'another run is active in that worktree');
	return fix;
}

// The commit the follow-up starts from, once the PR is known to be open: an
// approved-and-merged run has nothing left to push to.
async function followUpStart(run: WorkflowRun): Promise<string> {
	const view = await reviewView(run);
	if (view.state !== 'OPEN') error(409, `the PR is ${view.state.toLowerCase()}, so there is nothing to push to`);
	return wexec.headCommit(run.cwd);
}

// Runs with a fix-findings request checking its PR, so a second request (the
// overseer and a person at once) gets a 409 instead of a second session.
const reopening = new Set<string>();

// Reopen a finished run for one fix session over the findings its review let
// through; it commits and pushes to the open PR, then the run is done again.
// The run stays `done` while the PR is checked, so no other control can act on
// it in between; only a delete can, and then nothing is reopened.
const fixFindings: Handler = async (run, _body, actor) => {
	fixableStep(run);
	if (reopening.has(run.id)) error(409, 'a follow-up fix is already starting');
	reopening.add(run.id);
	try {
		await reopenForFix(run, await followUpStart(run), actor);
	} finally {
		reopening.delete(run.id);
	}
};

async function reopenForFix(run: WorkflowRun, head: string, actor: Actor): Promise<void> {
	if (store.getRun(run.id) !== run) return;
	const fix = fixableStep(run);
	run.status = 'running';
	run.followUp = { head };
	run.block = undefined;
	run.error = undefined;
	run.failures[fix.id] = 0;
	record(run, actor, 'fix-findings', fix.id);
	await enter(run, fix.id);
}

const HANDLERS: Record<RunAction, Handler> = {
	pause,
	takeover,
	resume,
	retry,
	cancel,
	answer,
	block,
	agent: setAgent,
	note,
	handoff,
	message: sendMessage,
	'fix-findings': fixFindings
};

export function isRunAction(action: string): action is RunAction {
	return (RUN_ACTIONS as readonly string[]).includes(action);
}

export async function runAction(id: string, action: RunAction, body: Record<string, unknown>): Promise<WorkflowRun> {
	const run = store.getRun(id);
	if (!run) error(404, 'run not found');
	const actor: Actor = { by: body.by === 'overseer' ? 'overseer' : 'human', reason: str(body.reason) || str(body.text) || action };
	await HANDLERS[action](run, body, actor);
	return run;
}

export interface DeleteRunOptions {
	// Keep the run's phase sessions in the session list.
	keepSessions?: boolean;
}

// Remove a run from the list. A live one is stopped first, so no agent turn or
// verify keeps working untracked; anything still in flight sees the run gone
// and drops. Its phase sessions go too, unless asked to keep them, except a
// session you took over, which is yours. The worktree and branch always stay:
// the run's PR may still be open.
export async function deleteRun(id: string, opts: DeleteRunOptions = {}): Promise<void> {
	const run = store.getRun(id);
	if (!run) error(404, 'run not found');
	const visit = openVisit(run);
	if (visit?.humanTouched) verifying.get(run.id)?.abort();
	else if (!core.isFinished(run)) closeOpen(run, 'deleted');
	await forget([run], opts);
}

// The phase sessions a delete removes: every visit's, except one being driven by hand.
function phaseSessions(run: WorkflowRun): string[] {
	const driven = openVisit(run)?.humanTouched ? openVisit(run)?.sessionId : undefined;
	const ids = run.visits.map((v) => v.sessionId).filter((s): s is string => !!s && s !== driven);
	return [...new Set(ids)];
}

// The runs leave the store before their sessions are deleted, so a session's
// deletion event finds no run to react to.
async function forget(runs: WorkflowRun[], opts: DeleteRunOptions): Promise<void> {
	store.removeRuns(runs.map((r) => r.id));
	for (const run of runs) {
		forgetTree(run.id);
		publishAgentEvent(run.id, 'run-deleted', { runId: run.id });
	}
	if (opts.keepSessions) return;
	for (const id of runs.flatMap(phaseSessions)) {
		await deleteSession(id).catch((e) => console.error(`[deck] phase session ${id} delete failed:`, e));
	}
}

// Remove every done or cancelled run. Nothing is running for them, so there is
// nothing to stop. Returns how many went.
export async function clearFinishedRuns(opts: DeleteRunOptions = {}): Promise<number> {
	const runs = store.listRuns().filter(core.isFinished);
	if (runs.length) await forget(runs, opts);
	return runs.length;
}

// The answer surface the phone already uses: a blocked run is answerable
// through its current phase session's answer route too.
export function blockedRunForSession(sessionId: string): WorkflowRun | undefined {
	return store.listRuns().find((r) => r.status === 'blocked' && core.lastVisit(r)?.sessionId === sessionId);
}

// ---- Wiring ----

// One subscription across HMR reloads, swapping nothing: the handler reads the
// store on each event.
const wiring = globalThis as { __deckWorkflowWired?: boolean };
if (!wiring.__deckWorkflowWired) {
	wiring.__deckWorkflowWired = true;
	agentFeed.on('event', onFeedEvent);
	setTimeout(recoverRuns, 3000).unref();
}
