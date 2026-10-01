// Workflow runs (issue #233): the dev and review loops as a state machine the
// deck server owns, one agent session per phase. These are the shapes shared by
// the server, the web UI, and the agent API; the engine's pure logic lives in
// server/workflow-core.ts and its orchestration in server/workflow-runner.ts.
import type { AgentKind, DeckEffort, SessionIssue } from './types';

// Which feed lane a workflow serves. Not called `kind`: in deck that is the agent
// CLI (claude, pi, codex, opencode).
export type WorkflowCategory = 'dev' | 'review';
export const WORKFLOW_CATEGORIES = ['dev', 'review'] as const satisfies readonly WorkflowCategory[];

// What a step runs on. Unset fields fall back to the project's remembered pick,
// then the CLI default, the same as an automation lane.
export interface StepAgent {
	kind?: AgentKind;
	model?: string;
	provider?: string;
	effort?: DeckEffort;
}

// What a step does, which decides the context it is handed, the output the engine
// reads back, and how the loop rules (round cap, escalations) apply to it.
export type StepRole =
	| 'implement'
	| 'verify'
	| 'review'
	| 'fix'
	| 'arbiter'
	| 'closer'
	| 'pr'
	| 'feedback'
	| 'pr-review';
export const STEP_ROLES = [
	'implement',
	'verify',
	'review',
	'fix',
	'arbiter',
	'closer',
	'pr',
	'feedback',
	'pr-review'
] as const satisfies readonly StepRole[];

// How a step passes. Every gate is computed from an exit code, a structured
// finding severity, or a `gh` query; none asks a model whether it passed.
export type StepGate = 'turn' | 'exit-zero' | 'no-blockers' | 'pr-linked' | 'pr-approved' | 'pr-reviewed';
export const STEP_GATES = [
	'turn',
	'exit-zero',
	'no-blockers',
	'pr-linked',
	'pr-approved',
	'pr-reviewed'
] as const satisfies readonly StepGate[];

// The end of the line for `next` / `onFail`.
export const DONE = 'done';

export interface WorkflowStep {
	id: string;
	label: string;
	role: StepRole;
	// A skill step runs `/<skill> <args>` in a fresh session. A verify step runs
	// `command` in the worktree, or the repo's detected test command when unset.
	skill?: string;
	args?: string;
	command?: string;
	// The agent for the first visit, later visits (review rounds 2+), and an
	// escalation (the implementer after a 2+ blocker first round).
	agent?: StepAgent;
	repeatAgent?: StepAgent;
	escalateAgent?: StepAgent;
	gate: StepGate;
	// The step to go to when the gate passes, or DONE.
	next: string;
	// The step to go to when the gate fails. Absent blocks the run.
	onFail?: string;
	// Mechanical retries of the same step (a crashed turn, missing structured
	// output) before the run blocks.
	retries?: number;
	// How many times the step may run in one run. Review uses it as the round cap.
	cap?: number;
}

export interface WorkflowDef {
	id: string;
	name: string;
	category: WorkflowCategory;
	// The one this category fires from the feed automation.
	default?: boolean;
	// The first step is the entry point.
	steps: WorkflowStep[];
}

export type RunStatus = 'running' | 'waiting' | 'paused' | 'blocked' | 'done' | 'cancelled';

// A run in one of these never moves again on its own.
export const FINISHED_RUN: readonly RunStatus[] = ['done', 'cancelled'];

// One review finding as dev-review emits it in its structured block.
export interface Finding {
	file: string;
	line?: number;
	severity: string;
	defect: string;
	fix?: string;
	keep?: string;
}

// The review's coverage manifest: what it read, and what it skipped (which feeds
// the next round's scope).
export interface Coverage {
	examined: string[];
	notExamined: string[];
}

export type VisitResult = 'pass' | 'fail' | 'error' | 'skipped' | 'interrupted';

// One visit to one step: a session (skill steps) or a command run (verify).
export interface PhaseVisit {
	step: string;
	visit: number;
	sessionId?: string;
	agent?: StepAgent;
	startedAt: number;
	endedAt?: number;
	result?: VisitResult;
	detail?: string;
	// A person drove this phase's session during a take-over.
	humanTouched?: boolean;
	// Review visits: the working-tree snapshot the reviewer was shown. It becomes
	// the run's `reviewTree` only once the round completes, so a round cut short
	// by a restart doesn't move the next round's baseline.
	tree?: string;
	// How the session's turn ended while the run was paused (not taken over), so
	// resuming this phase settles that turn instead of starting it again.
	pausedEnd?: string;
}

export type DecisionBy = 'overseer' | 'human' | 'engine';

// A call made on a run, kept so you can see where a run was steered and why.
export interface RunDecision {
	at: number;
	by: DecisionBy;
	step: string;
	action: string;
	reason: string;
}

// A question the run is waiting on a person for.
export interface RunBlock {
	question: string;
	at: number;
	by: DecisionBy;
	step: string;
}

// The intent note left by whoever was driving a phase, stamped with the
// working-tree snapshot it was written against so a stale one shows as stale.
export interface RunHandoff {
	text: string;
	tree: string;
	at: number;
}

export interface RunPr {
	repo: string;
	number: number;
	url?: string;
	title?: string;
	baseRefName?: string;
}

// The state the engine carries between phases. Steps 3 to 5 of the dev loop
// make no commits, so this plus the uncommitted working tree is the handoff.
export interface WorkflowRun {
	id: string;
	workflowId: string;
	workflowName: string;
	category: WorkflowCategory;
	// The definition as it was when the run started, so a removed or renamed
	// workflow can't break a run that is already going.
	steps: WorkflowStep[];
	projectPath: string;
	cwd: string;
	branch: string;
	base?: string;
	title: string;
	issue?: SessionIssue;
	pr?: RunPr;
	// The client profile's post-PR loop flag and reviewer, resolved at start.
	loop: boolean;
	reviewer?: string;
	status: RunStatus;
	phase: string;
	// Bumped by every pause, resume, retry, and cancel, so a completion that lands
	// after one of those can tell it is stale and do nothing.
	epoch: number;
	visits: PhaseVisit[];
	// Review rounds run so far.
	round: number;
	findings: Finding[];
	// Blockers earlier rounds raised (and the fix phases applied), so a fixer can
	// tell when a new finding asks to undo one.
	pastFindings?: Finding[];
	coverage?: Coverage;
	// The working-tree snapshot the last review saw, so the next round's delta is
	// computed from the tree (hand edits included), not from the last commit.
	reviewTree?: string;
	verifyOutput?: string;
	disagreement?: string;
	escalations: { implementer: boolean; disagreement: boolean; cap: boolean };
	// Per-run model overrides, keyed by step id (an overseer or a person changed one).
	stepAgents?: Record<string, StepAgent>;
	// Consecutive mechanical failures per step.
	failures: Record<string, number>;
	humanTouched: boolean;
	// The reviewer activity the last feedback round answered, so the next round
	// only starts when there is something new.
	feedbackSignature?: string;
	answers: { text: string; at: number }[];
	block?: RunBlock;
	handoff?: RunHandoff;
	decisions: RunDecision[];
	error?: string;
	// Set while a finished run is reopened to fix its leftover findings: the
	// commit the branch was at, so the gate can tell a new commit was pushed.
	followUp?: { head: string };
	createdAt: number;
	updatedAt: number;
}

// The git state the follow-up fix gate reads.
export interface PushState {
	head: string;
	branch: string;
	upstream: string | null;
	// e.g. `origin/feature`
	upstreamRef: string | null;
	// The branch's configured remote, e.g. `origin`.
	remote: string | null;
	clean: boolean;
	// HEAD still has the follow-up's starting commit in its history.
	descends: boolean;
}

// A finished dev run with an open PR and findings the review let through
// (nits, or blockers a closer left): one follow-up fix can address them.
export function canFixFindings(run: { status: RunStatus; category: WorkflowCategory; pr?: RunPr; findings: Finding[] }): boolean {
	return run.status === 'done' && run.category === 'dev' && !!run.pr && run.findings.length > 0;
}

// ---- The client-facing projection ----

export type PhaseStatus = 'pending' | 'active' | 'pass' | 'fail' | 'skipped';

export interface RunPhaseDigest {
	id: string;
	label: string;
	role: StepRole;
	status: PhaseStatus;
	// Times this phase has run. Looping phases (review, fix, verify) climb.
	visits: number;
	cap?: number;
	// Steps it can go to, so a client can draw the chain and its loop-backs.
	next: string;
	onFail?: string;
	sessions: { sessionId?: string; visit: number; result?: VisitResult; detail?: string; startedAt: number; endedAt?: number; humanTouched?: boolean }[];
	decisions: RunDecision[];
}

// A run as the agent API serves it: enough to draw the board, a run's phases,
// and the per-round session links without any HTML. Internal plumbing (epoch,
// tree snapshots, failure counters) is dropped.
export interface RunDigest {
	id: string;
	url: string;
	workflow: { id: string; name: string; category: WorkflowCategory };
	title: string;
	projectPath: string;
	cwd: string;
	branch: string;
	base?: string;
	issue?: SessionIssue;
	pr?: RunPr;
	status: RunStatus;
	phase: string;
	round: number;
	cap?: number;
	loop: boolean;
	blockers: number;
	findings: Finding[];
	escalations: WorkflowRun['escalations'];
	humanTouched: boolean;
	phases: RunPhaseDigest[];
	block?: RunBlock;
	handoff?: RunHandoff;
	error?: string;
	// A follow-up fix of leftover findings is in progress.
	followUp: boolean;
	createdAt: number;
	updatedAt: number;
}
