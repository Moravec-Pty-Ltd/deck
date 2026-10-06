// Pure logic for workflow runs (issue #233), node-free so it unit-tests without
// fs, git, or gh: the built-in workflows, the definition schema, the transition
// function, the phase prompts, the gates' parsing, and the run digest. The
// orchestration (sessions, commands, gh, the durable store) lives in
// workflow-runner.ts.
import { z } from 'zod';
import { EFFORT_LEVELS } from '$lib/effort';
import { AGENT_KINDS } from '$lib/types';
import type { SessionIssue } from '$lib/types';
import {
	type PushState,
	DONE,
	FINISHED_RUN,
	STEP_GATES,
	STEP_ROLES,
	WORKFLOW_CATEGORIES,
	type Coverage,
	type Finding,
	type PhaseStatus,
	type PhaseVisit,
	type RunDigest,
	type RunPhaseDigest,
	type RunPr,
	type StepAgent,
	type WorkflowCategory,
	type WorkflowDef,
	type WorkflowRun,
	type WorkflowStep
} from '$lib/workflows';

// ---- Built-in workflows ----

// The model tiers the dev-workflow skill already encodes: judgment work at the
// CLI's default (the session model), scoped verification and routine fixes at
// sonnet, and one shot at the top tier for a reviewer disagreement and for an
// exhausted round cap.
const SONNET: StepAgent = { kind: 'claude', model: 'sonnet' };
const SESSION: StepAgent = { kind: 'claude' };
const TOP: StepAgent = { kind: 'claude', model: 'claude-fable-5-1' };

const REVIEW_ROUND_CAP = 5;
const FEEDBACK_ROUND_CAP = 10;

// The dev loop with the prose stripped: a chain with two cycles in it (review
// and fix, then the reviewer's feedback after the PR is up).
const DEV_WORKFLOW: WorkflowDef = {
	id: 'dev',
	name: 'Dev workflow',
	category: 'dev',
	default: true,
	steps: [
		{ id: 'implement', label: 'Implement', role: 'implement', skill: 'dev-workflow', agent: SESSION, gate: 'turn', next: 'verify' },
		{ id: 'verify', label: 'Tests', role: 'verify', gate: 'exit-zero', next: 'review', onFail: 'fix', retries: 1 },
		{
			id: 'review',
			label: 'Review',
			role: 'review',
			skill: 'dev-review',
			agent: SESSION,
			repeatAgent: SONNET,
			gate: 'no-blockers',
			next: 'pr',
			onFail: 'fix',
			cap: REVIEW_ROUND_CAP
		},
		{ id: 'fix', label: 'Fix', role: 'fix', skill: 'dev-workflow', agent: SONNET, escalateAgent: SESSION, gate: 'turn', next: 'verify' },
		{ id: 'arbiter', label: 'Arbiter', role: 'arbiter', skill: 'dev-workflow', agent: TOP, gate: 'turn', next: 'verify', retries: 0 },
		{ id: 'closer', label: 'Closer', role: 'closer', skill: 'dev-workflow', agent: TOP, gate: 'turn', next: 'verify', retries: 0 },
		{ id: 'pr', label: 'Open PR', role: 'pr', skill: 'dev-workflow', agent: SONNET, gate: 'pr-linked', next: 'feedback', retries: 1 },
		{
			id: 'feedback',
			label: 'Reviewer feedback',
			role: 'feedback',
			skill: 'address-feedback',
			agent: SONNET,
			gate: 'pr-approved',
			next: DONE,
			cap: FEEDBACK_ROUND_CAP
		}
	]
};

const REVIEW_WORKFLOW: WorkflowDef = {
	id: 'review',
	name: 'PR review',
	category: 'review',
	default: true,
	steps: [
		{ id: 'review', label: 'Review', role: 'pr-review', skill: 'dev-review', agent: SESSION, gate: 'pr-reviewed', next: DONE }
	]
};

export const BUILTIN_WORKFLOWS: WorkflowDef[] = [DEV_WORKFLOW, REVIEW_WORKFLOW];

// ---- Definitions from ~/.deck/workflows.json ----

const agentSchema = z.object({
	kind: z.enum(AGENT_KINDS).optional(),
	model: z.string().optional(),
	provider: z.string().optional(),
	effort: z.enum(EFFORT_LEVELS).optional()
});

const stepSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	role: z.enum(STEP_ROLES),
	skill: z.string().optional(),
	args: z.string().optional(),
	command: z.string().optional(),
	agent: agentSchema.optional(),
	repeatAgent: agentSchema.optional(),
	escalateAgent: agentSchema.optional(),
	gate: z.enum(STEP_GATES),
	next: z.string().min(1),
	onFail: z.string().optional(),
	retries: z.number().int().min(0).max(5).optional(),
	cap: z.number().int().min(1).max(20).optional()
});

const defSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	category: z.enum(WORKFLOW_CATEGORIES),
	default: z.boolean().optional(),
	steps: z.array(stepSchema).min(1)
});

// The first transition that points nowhere, or null when every `next` and
// `onFail` names a step in the workflow (or DONE).
function danglingTransition(def: WorkflowDef): string | null {
	const ids = new Set(def.steps.map((s) => s.id));
	for (const s of def.steps) {
		for (const target of [s.next, s.onFail]) {
			if (target && target !== DONE && !ids.has(target)) return `${s.id} -> ${target}`;
		}
	}
	return null;
}

// A step id the engine can't reach: used twice, or `done`, which ends a run.
function idProblem(def: WorkflowDef): string | null {
	const ids = def.steps.map((s) => s.id);
	const dup = ids.find((id, i) => ids.indexOf(id) !== i);
	if (dup) return `step id used twice: ${dup}`;
	return ids.includes(DONE) ? `"${DONE}" is reserved and can't be a step id` : null;
}

// The gate each role must use where the role has a computed check, so a user
// definition can't swap one for a gate that passes on any reply. Roles absent
// here (implement, fix, arbiter, closer) are gated on their turn.
const ROLE_GATE: Partial<Record<WorkflowStep['role'], WorkflowStep['gate']>> = {
	verify: 'exit-zero',
	review: 'no-blockers',
	pr: 'pr-linked',
	feedback: 'pr-approved',
	'pr-review': 'pr-reviewed'
};

function gateFits(s: WorkflowStep): boolean {
	return s.gate === (ROLE_GATE[s.role] ?? 'turn');
}

// A step whose role can't work as declared: a session step with no skill, or a
// gate that doesn't match what the role is checked by.
function roleProblem(def: WorkflowDef): string | null {
	const bare = def.steps.find((s) => s.role !== 'verify' && !s.skill);
	if (bare) return `step ${bare.id} names no skill`;
	const loose = def.steps.find((s) => !gateFits(s));
	return loose ? `${loose.role} step ${loose.id} must use the ${ROLE_GATE[loose.role] ?? 'turn'} gate` : null;
}

// A shape problem the schema can't see.
function stepProblem(def: WorkflowDef): string | null {
	const dangling = danglingTransition(def);
	return idProblem(def) ?? roleProblem(def) ?? (dangling && `step transition points nowhere: ${dangling}`);
}

function schemaProblem(raw: unknown, err: z.ZodError): string {
	const id = (raw as { id?: unknown })?.id;
	const issue = err.issues[0];
	return `${typeof id === 'string' ? id : 'workflow'}: ${[...(issue?.path ?? []), issue?.message ?? 'invalid'].join(' ')}`;
}

// One user definition, or the reason it was rejected.
function parseDef(raw: unknown): { def?: WorkflowDef; problem?: string } {
	const parsed = defSchema.safeParse(raw);
	if (!parsed.success) return { problem: schemaProblem(raw, parsed.error) };
	const problem = stepProblem(parsed.data);
	return problem ? { problem: `${parsed.data.id}: ${problem}` } : { def: parsed.data };
}

// The user's definitions merged over the built-ins: a user workflow with a
// built-in's id replaces it, and one marked `default` takes the default for its
// category. A malformed entry is skipped and reported, never fatal.
export function resolveWorkflows(raw: unknown): { workflows: WorkflowDef[]; problems: string[] } {
	const list = Array.isArray((raw as { workflows?: unknown })?.workflows)
		? ((raw as { workflows: unknown[] }).workflows)
		: [];
	const byId = new Map(BUILTIN_WORKFLOWS.map((w) => [w.id, w]));
	const problems: string[] = [];
	for (const item of list) {
		const { def, problem } = parseDef(item);
		if (def) byId.set(def.id, def);
		else problems.push(problem!);
	}
	return { workflows: withOneDefault([...byId.values()]), problems };
}

// Exactly one default per category: the last one marked wins, so a user
// workflow marked default displaces the built-in. A category with none marked
// (a user def replaced the built-in without saying `default`) falls back to its
// first workflow, so the feed automation always has something to fire.
function withOneDefault(defs: WorkflowDef[]): WorkflowDef[] {
	const winner = new Map<WorkflowCategory, string>();
	for (const d of defs) if (!winner.has(d.category)) winner.set(d.category, d.id);
	const marked = new Map<WorkflowCategory, string>();
	for (const d of defs) if (d.default) marked.set(d.category, d.id);
	for (const [category, id] of marked) winner.set(category, id);
	return defs.map((d) => ({ ...d, default: winner.get(d.category) === d.id }));
}

// The workflow a start asks for: by id when given, else the category default.
export function pickWorkflow(
	defs: WorkflowDef[],
	want: { id?: string; category?: WorkflowCategory }
): WorkflowDef | undefined {
	if (want.id) return defs.find((d) => d.id === want.id);
	return defs.find((d) => d.category === (want.category ?? 'dev') && d.default);
}

// ---- Client profiles (the dev-workflow skill's clients.json) ----

export interface ClientProfile {
	prefixes?: string[];
	githubOwners?: string[];
	reviewer?: string;
	baseBranch?: string | null;
	loopDefault?: boolean;
}

export interface ResolvedProfile {
	loop: boolean;
	reviewer?: string;
	baseBranch?: string;
}

function toResolved(p: ClientProfile | undefined): ResolvedProfile {
	return { loop: !!p?.loopDefault, reviewer: p?.reviewer || undefined, baseBranch: p?.baseBranch || undefined };
}

// The profile for a run, by the same rule the skill uses: a GitHub owner maps to
// the profile listing it (else the generic `github` profile), a Linear id to the
// profile whose prefixes hold its prefix. No match runs without the post-PR loop.
export function matchProfile(
	profiles: Record<string, ClientProfile>,
	at: { owner?: string; issue?: Pick<SessionIssue, 'source' | 'id'> }
): ResolvedProfile {
	const entries = Object.values(profiles);
	if (at.issue?.source === 'linear') {
		const prefix = at.issue.id.split('-')[0];
		return toResolved(entries.find((p) => p.prefixes?.includes(prefix)));
	}
	const owner = at.owner?.toLowerCase();
	const byOwner = entries.find((p) => p.githubOwners?.some((o) => o.toLowerCase() === owner));
	return toResolved(byOwner ?? profiles.github);
}

// ---- Starting a run ----

export interface NewRunInput {
	id: string;
	def: WorkflowDef;
	projectPath: string;
	cwd: string;
	branch: string;
	base?: string;
	title: string;
	issue?: SessionIssue;
	pr?: RunPr;
	profile: ResolvedProfile;
	now: number;
}

export function newRun(input: NewRunInput): WorkflowRun {
	const { def, profile, now } = input;
	return {
		id: input.id,
		workflowId: def.id,
		workflowName: def.name,
		category: def.category,
		steps: def.steps,
		projectPath: input.projectPath,
		cwd: input.cwd,
		branch: input.branch,
		base: input.base,
		title: input.title,
		issue: input.issue,
		pr: input.pr,
		loop: profile.loop,
		reviewer: profile.reviewer,
		status: 'running',
		phase: def.steps[0].id,
		epoch: 0,
		visits: [],
		round: 0,
		findings: [],
		escalations: { implementer: false, disagreement: false, cap: false },
		failures: {},
		humanTouched: false,
		answers: [],
		decisions: [],
		createdAt: now,
		updatedAt: now
	};
}

export function stepById(run: Pick<WorkflowRun, 'steps'>, id: string): WorkflowStep | undefined {
	return run.steps.find((s) => s.id === id);
}

export function currentStep(run: WorkflowRun): WorkflowStep | undefined {
	return stepById(run, run.phase);
}

export function isFinished(run: Pick<WorkflowRun, 'status'>): boolean {
	return FINISHED_RUN.includes(run.status);
}

function visitsOf(run: WorkflowRun, stepId: string): PhaseVisit[] {
	return run.visits.filter((v) => v.step === stepId);
}

export function lastVisit(run: WorkflowRun): PhaseVisit | undefined {
	return run.visits.at(-1);
}

// The agent a step's next visit runs on: a per-run override first, then the
// escalated implementer, then the later-round tier, then the step's own pick.
export function agentFor(run: WorkflowRun, step: WorkflowStep): StepAgent {
	const override = run.stepAgents?.[step.id];
	if (override) return override;
	if (step.role === 'fix' && run.escalations.implementer && step.escalateAgent) return step.escalateAgent;
	if (visitsOf(run, step.id).length > 0 && step.repeatAgent) return step.repeatAgent;
	return step.agent ?? {};
}

// Open a visit to `stepId` and make it the run's phase. A feedback step starts
// out waiting on the reviewer rather than running.
export function beginVisit(run: WorkflowRun, stepId: string, now: number): PhaseVisit {
	const step = stepById(run, stepId)!;
	const visit: PhaseVisit = {
		step: stepId,
		visit: visitsOf(run, stepId).length + 1,
		agent: step.skill ? agentFor(run, step) : undefined,
		startedAt: now
	};
	run.visits.push(visit);
	run.phase = stepId;
	run.status = step.role === 'feedback' ? 'waiting' : 'running';
	run.updatedAt = now;
	return visit;
}

// ---- Structured output ----

const findingSchema = z.object({
	file: z.string(),
	line: z.number().int().optional().catch(undefined),
	// Normalised once here, so the gate, the digest, and the prompts all compare
	// the same `blocker`.
	severity: z.string().transform((s) => s.toLowerCase()),
	defect: z.string(),
	fix: z.string().optional().catch(undefined),
	keep: z.string().optional().catch(undefined)
});

const coverageSchema = z.object({
	examined: z.array(z.string()).catch([]),
	notExamined: z.array(z.string()).catch([])
});

// What a phase's closing ```json block can carry. Every field is optional; the
// role decides which ones it needs.
export interface Structured {
	findings?: Finding[];
	coverage?: Coverage;
	disagreements?: string[];
	dismissed?: boolean;
	reason?: string;
}

// At least one known key, so an unrelated JSON snippet quoted last in a reply
// can't stand in for the real verdict block above it.
const structuredSchema = z
	.object({
		findings: z.array(findingSchema).optional(),
		coverage: coverageSchema.optional(),
		disagreements: z.array(z.string()).optional(),
		dismissed: z.boolean().optional(),
		reason: z.string().optional()
	})
	.refine((o) => Object.keys(o).length > 0);

const FENCE = /```json\s*\n([\s\S]*?)\n\s*```/g;

// The last ```json block in a phase's final reply that parses into the
// structured shape, or null when there is none. The last one wins so a reply
// that quotes an example earlier still reads its real verdict.
export function parseStructured(text: string | null | undefined): Structured | null {
	if (!text) return null;
	const blocks = [...text.matchAll(FENCE)].map((m) => m[1]).reverse();
	for (const block of blocks) {
		const parsed = structuredSchema.safeParse(safeJson(block));
		if (parsed.success) return parsed.data;
	}
	return null;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function blockerCount(findings: Finding[]): number {
	return findings.filter((f) => f.severity === 'blocker').length;
}

// ---- The transition function ----

// What a finished visit produced, as the runner computed it.
export interface GateResult {
	pass: boolean;
	// Passed because there was nothing to check (a repo with no test command).
	skipped?: boolean;
	// The step could not produce a verdict at all (a crashed turn, a missing
	// structured block, a gh error). Retried, then the run blocks.
	error?: string;
	detail?: string;
	structured?: Structured;
	// A verify step's output, handed to the fix phase when it is red.
	output?: string;
}

// What the runner must do next.
export type Effect = { type: 'enter'; step: string } | { type: 'wait' } | { type: 'block' } | { type: 'done' };

const VERIFY_RED_CAP = 3;

function decide(run: WorkflowRun, step: string, action: string, reason: string, now: number): void {
	run.decisions.push({ at: now, by: 'engine', step, action, reason });
}

export function blockRun(run: WorkflowRun, step: string, question: string, now: number, by: 'engine' | 'overseer' | 'human' = 'engine'): Effect {
	run.status = 'blocked';
	run.block = { question, at: now, by, step };
	run.updatedAt = now;
	return { type: 'block' };
}

// Move to `target`, ending the run on DONE. The feedback step is skipped when
// the client profile has the post-PR loop off.
function goTo(run: WorkflowRun, target: string, now: number): Effect {
	const step = target === DONE ? undefined : stepById(run, target);
	if (step?.role === 'feedback' && !run.loop) return goTo(run, step.next, now);
	if (target === DONE) {
		run.status = 'done';
		run.updatedAt = now;
		return { type: 'done' };
	}
	if (!step) return blockRun(run, run.phase, `The workflow has no step "${target}".`, now);
	return { type: 'enter', step: target };
}

function failTo(run: WorkflowRun, step: WorkflowStep, reason: string, now: number): Effect {
	if (step.onFail) return goTo(run, step.onFail, now);
	return blockRun(run, step.id, reason, now);
}

function passOrFail(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (result.pass) return goTo(run, step.next, now);
	return failTo(run, step, `${step.label} did not pass: ${result.detail ?? 'gate failed'}`, now);
}

function onVerify(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	const key = `${step.id}#red`;
	if (result.pass) {
		run.verifyOutput = undefined;
		run.failures[key] = 0;
		return goTo(run, step.next, now);
	}
	run.verifyOutput = result.output;
	run.failures[key] = (run.failures[key] ?? 0) + 1;
	if (run.failures[key] >= VERIFY_RED_CAP) {
		return blockRun(run, step.id, `${step.label} stayed red after ${VERIFY_RED_CAP} fix attempts.`, now);
	}
	return failTo(run, step, `${step.label} failed.`, now);
}

function stepWithRole(run: WorkflowRun, role: WorkflowStep['role']): WorkflowStep | undefined {
	return run.steps.find((s) => s.role === role);
}

// Blockers still standing at the round cap get one top-tier closer, then the
// run blocks for a person.
function onReviewCap(run: WorkflowRun, step: WorkflowStep, blockers: number, now: number): Effect {
	const closer = stepWithRole(run, 'closer');
	if (closer && !run.escalations.cap) {
		run.escalations.cap = true;
		decide(run, step.id, 'escalate', `${blockers} blockers still standing after ${run.round} rounds; one pass at the top tier.`, now);
		return goTo(run, closer.id, now);
	}
	return blockRun(run, step.id, `${blockers} blockers still standing after ${run.round} review rounds.`, now);
}

// Keep this round's findings and move the last round's blockers into history.
function recordRound(run: WorkflowRun, structured: Structured | undefined): number {
	run.round += 1;
	run.verifyOutput = undefined;
	run.reviewTree = lastVisit(run)?.tree ?? run.reviewTree;
	run.pastFindings = [...(run.pastFindings ?? []), ...run.findings.filter((f) => f.severity === 'blocker')].slice(-50);
	run.findings = structured?.findings ?? [];
	run.coverage = structured?.coverage;
	return blockerCount(run.findings);
}

// Two or more blockers in round 1 prove the task needed the stronger implementer.
function maybeEscalateImplementer(run: WorkflowRun, step: WorkflowStep, blockers: number, now: number): void {
	if (run.round !== 1 || blockers < 2 || run.escalations.implementer) return;
	run.escalations.implementer = true;
	decide(run, step.id, 'escalate', `Round 1 found ${blockers} blockers; fixes move to the stronger implementer.`, now);
}

function onReview(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	const blockers = recordRound(run, result.structured);
	maybeEscalateImplementer(run, step, blockers, now);
	if (blockers === 0) return goTo(run, step.next, now);
	if (run.round >= (step.cap ?? REVIEW_ROUND_CAP)) return onReviewCap(run, step, blockers, now);
	return failTo(run, step, `${blockers} blockers.`, now);
}

// A follow-up fix ends the run again once its commit is pushed.
function onFollowUp(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (!result.pass) return blockRun(run, step.id, `The follow-up fix did not land: ${result.detail ?? 'no pushed commit'}`, now);
	decide(run, step.id, 'follow-up', `Leftover findings addressed in ${result.detail ?? 'a pushed commit'}.`, now);
	run.followUp = undefined;
	run.findings = [];
	return goTo(run, DONE, now);
}

// A fix that would undo what an earlier round demanded goes to the arbiter once;
// a second disagreement goes to a person.
function onFix(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (run.followUp) return onFollowUp(run, step, result, now);
	const disagreements = result.structured?.disagreements ?? [];
	if (!disagreements.length) return passOrFail(run, step, result, now);
	run.disagreement = disagreements.join('\n');
	const arbiter = stepWithRole(run, 'arbiter');
	if (arbiter && !run.escalations.disagreement) {
		run.escalations.disagreement = true;
		decide(run, step.id, 'escalate', 'A review round asked to undo an earlier fix; one ruling at the top tier.', now);
		return goTo(run, arbiter.id, now);
	}
	return blockRun(run, step.id, `Review rounds disagree:\n${run.disagreement}`, now);
}

// The closer either fixed the blockers (verify, then one final review round) or
// ruled them invalid, which is recorded and skips past review.
function onCloser(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (!result.structured?.dismissed) return passOrFail(run, step, result, now);
	decide(run, step.id, 'dismiss', result.structured.reason ?? 'The closer ruled the standing blockers invalid.', now);
	run.findings = [];
	const review = stepWithRole(run, 'review');
	return goTo(run, review?.next ?? step.next, now);
}

// The reviewer loop ends when the PR is approved with nothing open (or merged);
// otherwise the run waits for the reviewer's next pass.
function onFeedback(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (result.pass) return goTo(run, step.next, now);
	if (visitsOf(run, step.id).length >= (step.cap ?? FEEDBACK_ROUND_CAP)) {
		return blockRun(run, step.id, `Reviewer feedback still open after ${step.cap ?? FEEDBACK_ROUND_CAP} rounds.`, now);
	}
	run.status = 'waiting';
	return { type: 'wait' };
}

const HANDLERS: Partial<Record<WorkflowStep['role'], typeof passOrFail>> = {
	verify: onVerify,
	review: onReview,
	fix: onFix,
	closer: onCloser,
	feedback: onFeedback
};

// A visit that produced no verdict: retry the same step, then block.
function onError(run: WorkflowRun, step: WorkflowStep, error: string, now: number): Effect {
	run.failures[step.id] = (run.failures[step.id] ?? 0) + 1;
	if (run.failures[step.id] <= (step.retries ?? 1)) {
		decide(run, step.id, 'retry', error, now);
		return { type: 'enter', step: step.id };
	}
	return blockRun(run, step.id, `${step.label} failed: ${error}`, now);
}

function closeVisit(run: WorkflowRun, result: GateResult, now: number): void {
	const visit = lastVisit(run);
	if (!visit || visit.endedAt) return;
	visit.endedAt = now;
	visit.result = result.error ? 'error' : result.skipped ? 'skipped' : result.pass ? 'pass' : 'fail';
	visit.detail = result.error ?? result.detail;
}

// Record a finished visit and decide what happens next. Mutates `run`.
export function advance(run: WorkflowRun, result: GateResult, now: number): Effect {
	const step = currentStep(run);
	if (!step) return blockRun(run, run.phase, `The workflow has no step "${run.phase}".`, now);
	closeVisit(run, result, now);
	run.updatedAt = now;
	if (result.error) return onError(run, step, result.error, now);
	run.failures[step.id] = 0;
	return (HANDLERS[step.role] ?? passOrFail)(run, step, result, now);
}

// ---- Phase prompts ----

export interface PromptContext {
	// Round 2+ review scope as file ranges.
	delta?: string[];
	// The issue's own text, fetched once when the phase starts (see
	// server/issues/prompt.ts). Handed to the phase so it reads the issue from
	// the prompt rather than spending a tool call and its tokens fetching what
	// deck already has. Absent for a run with no issue, or when the fetch failed.
	issue?: IssueText;
}

// What an issue says, as the prompt renders it. Mirrors IssuePromptContext in
// server/issues/detail.ts, kept structural so this node-free module doesn't
// depend on the fetcher.
export interface IssueText {
	issueTitle?: string;
	issueBody?: string;
	issueComments?: string;
	warnings?: string[];
}

const trimmed = (v: string | undefined) => (v ?? '').trim();

// Why the issue's text is missing, so a phase doesn't read an empty block as an
// empty issue. Nothing when the fetch simply wasn't asked for.
function issueUnreadable(issue: IssueText, run: WorkflowRun): string {
	if (!issue.warnings?.length) return '';
	return `Could not read ${issueRef(run)}: ${issue.warnings.join('; ')}`;
}

// The issue's text as a block the phase can read. Bounded by the fetcher, not
// here.
function issueBlock(ctx: PromptContext, run: WorkflowRun): string {
	const issue = ctx.issue;
	if (!issue) return '';
	const title = trimmed(issue.issueTitle);
	const body = trimmed(issue.issueBody);
	const comments = trimmed(issue.issueComments);
	if (!title && !body && !comments) return issueUnreadable(issue, run);
	return [
		`${issueRef(run)}${title ? ` — ${title}` : ''}`,
		body,
		comments && `Comments:\n${comments}`,
		'That is the issue in full, already fetched. Do not go and read it again.'
	]
		.filter(Boolean)
		.join('\n\n');
}

const FINDINGS_CONTRACT = [
	'End your reply with one fenced ```json block, exactly this shape, so the workflow can read the verdict:',
	'{"findings":[{"file":"path","line":1,"severity":"blocker|nit","defect":"...","fix":"...","keep":"..."}],',
	' "coverage":{"examined":["path"],"notExamined":["path: why"]}}',
	'Use severity "blocker" only for what must change before this ships. An empty findings list means clean.'
].join('\n');

const PHASE_NOTE = 'This session is one phase of a deck workflow run. Another phase does the next step; stop when yours is done.';

function issueRef(run: WorkflowRun): string {
	return run.issue?.url || run.issue?.id || run.title;
}

function skillLine(step: WorkflowStep, args: string): string {
	return [`/${step.skill ?? ''}`, step.args, args].filter(Boolean).join(' ');
}

function asJson(value: unknown): string {
	return '```json\n' + JSON.stringify(value, null, 1) + '\n```';
}

function implementPrompt(run: WorkflowRun, step: WorkflowStep, ctx: PromptContext): string[] {
	const issue = issueBlock(ctx, run);
	return [
		skillLine(step, `${issueRef(run)} base-branch=${run.base ?? ''}`.trim()),
		PHASE_NOTE,
		issue,
		issue
			? 'Run the skill as far as tests passing and no further: implement what the issue above asks for, add tests, get them green.'
			: 'Run the skill as far as tests passing and no further: read the issue, implement, add tests, get them green.',
		'You are already on the run\'s branch and worktree; do not create another. Do not commit, do not run the review loop, and do not open a PR.'
	];
}

function reviewScope(run: WorkflowRun, ctx: PromptContext): string {
	if (run.round === 0 || !ctx.delta?.length) {
		return `Scope: the whole branch diff against ${run.base ?? 'the base branch'}, including uncommitted changes.`;
	}
	const skipped = run.coverage?.notExamined ?? [];
	return [
		'Scope: these ranges and the callers and consumers of what they touch:',
		...ctx.delta.map((d) => `- ${d}`),
		...(skipped.length ? ['Also read these, which an earlier pass did not examine:', ...skipped.map((d) => `- ${d}`)] : [])
	].join('\n');
}

function reviewPrompt(run: WorkflowRun, step: WorkflowStep, ctx: PromptContext): string[] {
	return [
		skillLine(step, ''),
		PHASE_NOTE,
		'You did not write this code. Do not edit anything; return findings only.',
		`The change is for ${issueRef(run)}; judge it against that issue's acceptance criteria.`,
		reviewScope(run, ctx),
		FINDINGS_CONTRACT
	];
}

// A finished run reopened to clear what the review let through. The PR is
// already open, so this session commits and pushes to it itself.
function followUpPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [
		skillLine(step, issueRef(run)),
		PHASE_NOTE,
		`The PR for this work is open: ${run.pr?.url ?? `${run.pr?.repo}#${run.pr?.number}`}. Its review passed, but left these findings:`,
		asJson(run.findings),
		"Address each one in the working tree. Treat a suggested fix as a hypothesis: re-derive it from the defect, apply it at the narrowest scope, and keep what each finding's `keep` names. Get the tests green.",
		`Then make one commit and push it to the PR branch (${run.branch}). Do not open a new PR and do not run a review.`
	];
}

function fixPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	if (run.followUp) return followUpPrompt(run, step);
	// verifyOutput is set only while verify is red, and cleared when it passes.
	const task = run.verifyOutput
		? ['The tests or typecheck failed. Fix the cause. Output tail:', '```', run.verifyOutput!, '```']
		: ['Address these review findings in the working tree:', asJson(run.findings.filter((f) => f.severity === 'blocker'))];
	const earlier = run.pastFindings?.length ? ['Earlier review rounds asked for these, and they were applied:', asJson(run.pastFindings)] : [];
	return [
		skillLine(step, issueRef(run)),
		PHASE_NOTE,
		...task,
		...earlier,
		'Treat a suggested fix as a hypothesis: re-derive it from the defect, apply it at the narrowest scope, and keep what each finding\'s `keep` names. Get the tests green. Do not commit and do not run a review.',
		'If a finding asks you to undo something an earlier round demanded, do not apply it. List each one in a fenced ```json block: {"disagreements":["finding vs earlier finding, verbatim"]}.'
	];
}

function arbiterPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [
		skillLine(step, issueRef(run)),
		PHASE_NOTE,
		'Two review rounds disagree. Rule which invariant wins and why, then apply the ruling in the working tree. Do not commit.',
		run.disagreement ?? ''
	];
}

function closerPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [
		skillLine(step, issueRef(run)),
		PHASE_NOTE,
		`These blockers are still standing after ${run.round} review rounds:`,
		asJson(run.findings.filter((f) => f.severity === 'blocker')),
		'Either produce the correct fix in the working tree (tests green, no commit), or rule them invalid.',
		'End with a fenced ```json block: {"dismissed": true or false, "reason": "why"}.'
	];
}

function prPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	const reviewer = run.reviewer ? ` reviewer=${run.reviewer}` : '';
	return [
		skillLine(step, `${issueRef(run)} base-branch=${run.base ?? ''}${reviewer} loop=no`),
		PHASE_NOTE,
		'The work in this worktree is implemented, tested, and reviewed. Run the commit and PR step only: one commit, push, open the PR with the issue linked by a closing keyword, request the reviewers. Do not run any review loop.'
	];
}

function feedbackPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [skillLine(step, run.pr?.url ?? ''), PHASE_NOTE, 'Run a single pass, not --watch.'];
}

function prReviewPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [skillLine(step, `${run.pr?.url ?? run.pr?.number ?? ''} --verdict`), PHASE_NOTE];
}

const PROMPTS: Record<WorkflowStep['role'], (run: WorkflowRun, step: WorkflowStep, ctx: PromptContext) => string[]> = {
	implement: implementPrompt,
	verify: () => [],
	review: reviewPrompt,
	fix: fixPrompt,
	arbiter: arbiterPrompt,
	closer: closerPrompt,
	pr: prPrompt,
	feedback: feedbackPrompt,
	'pr-review': prReviewPrompt
};

// What a person told the run, and the last driver's intent note. Never handed
// to a review phase: its value is that nobody told it what to think.
function steering(run: WorkflowRun, step: WorkflowStep): string[] {
	if (step.role === 'review' || step.role === 'pr-review') return [];
	const out: string[] = [];
	if (run.answers.length) out.push('Answers from the person running this:', ...run.answers.map((a) => `- ${a.text}`));
	if (run.handoff) out.push(`Handoff note from the previous driver (written against tree ${run.handoff.tree.slice(0, 10)}):`, run.handoff.text);
	return out;
}

export function phasePrompt(run: WorkflowRun, step: WorkflowStep, ctx: PromptContext = {}): string {
	return [...PROMPTS[step.role](run, step, ctx), ...steering(run, step)].filter(Boolean).join('\n\n');
}

// ---- Gates computed from outside data ----

// Why a start names a PR from another repo than the project's origin, or null
// when they match (or the origin can't be read, e.g. a local remote). The PR is
// fetched from the project's own origin, so a mismatch would check out and
// review a different PR with the same number. Issues may live in a separate
// tracker repo, so they aren't checked.
export function repoMismatch(origin: string | null, pr: Pick<RunPr, 'repo'> | undefined): string | null {
	if (!origin || !pr || pr.repo.toLowerCase() === origin.toLowerCase()) return null;
	return `${pr.repo} is not this project's repo (${origin})`;
}

// Why a follow-up fix hasn't landed on the PR branch, or null when it has: the
// session committed on the run's branch, kept history, left nothing
// uncommitted, and pushed to that branch's own upstream.
export function followUpProblem(state: PushState, from: string, branch: string): string | null {
	if (state.branch !== branch) return `the worktree is on ${state.branch}, not ${branch}`;
	if (!state.clean) return 'changes were left uncommitted';
	if (state.head === from) return 'no new commit';
	if (!state.descends) return 'the branch history was rewritten';
	if (state.head !== state.upstream || state.upstreamRef !== `${state.remote}/${branch}`) return 'the new commit is not pushed to the PR branch';
	return null;
}

// The number a closing keyword must name, for a GitHub-sourced issue
// (`owner/repo#233`). null for other sources, which link by comment instead.
export function githubIssueNumber(issue: Pick<SessionIssue, 'source' | 'id'> | undefined): number | null {
	if (issue?.source !== 'github') return null;
	const n = Number(issue.id.split('#').pop());
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// The repo's test-and-typecheck command from its package.json scripts, run with
// the package manager its lockfile names. null when there is nothing to run.
export function detectVerifyCommand(scripts: Record<string, string> | undefined, lockfiles: string[]): string | null {
	if (!scripts) return null;
	const pm = lockfiles.includes('pnpm-lock.yaml') ? 'pnpm' : lockfiles.includes('yarn.lock') ? 'yarn' : lockfiles.includes('bun.lockb') ? 'bun' : 'npm';
	const parts = ['check', 'typecheck'].filter((s) => scripts[s]).slice(0, 1).map((s) => `${pm} run ${s}`);
	if (scripts.test) parts.push(`${pm} test`);
	return parts.length ? parts.join(' && ') : null;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// `git diff -U0` as file ranges (`src/a.ts:L10-14`), the scope a later review
// round is handed. A pure deletion is a single line where it happened.
export function deltaRanges(diff: string): string[] {
	const ranges = new Map<string, string[]>();
	let file: string | null = null;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.slice(6);
		const range = file ? hunkRange(line) : null;
		if (range) ranges.set(file!, [...(ranges.get(file!) ?? []), range]);
	}
	return [...ranges].map(([f, r]) => `${f}:${r.join(',')}`);
}

// A hunk header's new-side lines as `L4-6` (or `L4`), or null for any other line.
function hunkRange(line: string): string | null {
	const hunk = HUNK.exec(line);
	if (!hunk) return null;
	const start = Number(hunk[1]);
	const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
	return count > 1 ? `L${start}-${start + count - 1}` : `L${start}`;
}

export interface PrReviewView {
	state: string;
	reviewDecision: string | null;
	reviews: { author: string; state: string; commit?: string }[];
	headRefOid: string;
	unresolvedThreads: number;
	// Reviewers asked but not yet answered. Undercounts bot reviewers, which
	// gh omits from reviewRequests (see workflow-exec.ts).
	pendingReviewers: number;
}

function latestPerAuthor(reviews: PrReviewView['reviews']): string[] {
	const latest = new Map<string, string>();
	for (const r of reviews) if (r.state !== 'COMMENTED') latest.set(r.author, r.state);
	return [...latest.values()];
}

// Whether the reviewer loop is over: the PR merged or closed, or settled with
// nothing left to answer.
//
// "Settled" is stricter than it was, because it used to call a PR done on one
// approval and then a blocking review would arrive. Three things had to change:
// an approval no longer settles a PR while a reviewer still owes one, a
// CHANGES_REQUESTED is never overridden by the PR-wide decision, and the
// decision is preferred over counting approvals because it is the only signal
// that knows how many are required.
export function feedbackTerminal(view: PrReviewView): boolean {
	if (view.state === 'MERGED' || view.state === 'CLOSED') return true;
	if (view.unresolvedThreads > 0) return false;
	// Someone was asked and has not answered. Whatever has come in so far is a
	// partial picture, which is exactly how a late blocker gets missed.
	if (view.pendingReviewers > 0) return false;
	const verdicts = latestPerAuthor(view.reviews);
	// A blocking verdict ends it whatever the PR-wide decision says. The two
	// disagree while GitHub recomputes, and this is the direction where being
	// wrong costs something.
	if (verdicts.includes('CHANGES_REQUESTED')) return false;
	// With review requirements configured, the decision knows whether enough of
	// the right people have approved; counting approvals does not. Fall back to
	// the tally only when there is no decision to read.
	if (view.reviewDecision) return view.reviewDecision === 'APPROVED';
	return verdicts.includes('APPROVED');
}

// Reviewers whose latest verdict blocks the PR.
//
// GitHub does not ask a reviewer to look again when the author pushes a fix, so
// after a round answers a blocker the PR sits blocked with nobody holding it.
// These are who to ask again. Dismissed and commented-only reviews are not
// blockers and are left alone.
export function blockingReviewers(view: PrReviewView): string[] {
	const latest = new Map<string, string>();
	for (const r of view.reviews) if (r.state !== 'COMMENTED') latest.set(r.author, r.state);
	return [...latest]
		.filter(([author, state]) => state === 'CHANGES_REQUESTED' && author)
		.map(([author]) => author);
}

// The reviewer activity a feedback round answers. A new review or a change in
// open threads is new activity; the round's own replies resolve threads, so the
// signature is taken again when a round ends.
export function feedbackSignature(view: PrReviewView): string {
	return `${view.reviews.length}:${view.unresolvedThreads}`;
}

export function feedbackDue(view: PrReviewView, last: string | undefined): boolean {
	const active = view.reviews.length > 0 || view.unresolvedThreads > 0;
	return active && feedbackSignature(view) !== last;
}

// The pr-review gate: my review is on the PR's current head.
export function reviewedAtHead(view: PrReviewView, me: string): boolean {
	return view.reviews.some((r) => r.author === me && r.commit === view.headRefOid);
}

// ---- The digest ----

function phaseStatus(run: WorkflowRun, step: WorkflowStep, visits: PhaseVisit[]): PhaseStatus {
	if (run.phase === step.id && !isFinished(run)) return 'active';
	const last = visits.at(-1);
	if (!last) return 'pending';
	if (last.result === 'pass' || last.result === 'skipped') return last.result;
	return last.result ? 'fail' : 'active';
}

function phaseDigest(run: WorkflowRun, step: WorkflowStep): RunPhaseDigest {
	const visits = visitsOf(run, step.id);
	return {
		id: step.id,
		label: step.label,
		role: step.role,
		status: phaseStatus(run, step, visits),
		visits: visits.length,
		cap: step.cap,
		next: step.next,
		onFail: step.onFail,
		sessions: visits.map((v) => ({
			sessionId: v.sessionId,
			visit: v.visit,
			result: v.result,
			detail: v.detail,
			startedAt: v.startedAt,
			endedAt: v.endedAt,
			humanTouched: v.humanTouched
		})),
		decisions: run.decisions.filter((d) => d.step === step.id)
	};
}

export function runDigest(run: WorkflowRun, baseUrl: string): RunDigest {
	const review = stepWithRole(run, 'review');
	return {
		id: run.id,
		url: `${baseUrl}/runs/${run.id}`,
		workflow: { id: run.workflowId, name: run.workflowName, category: run.category },
		title: run.title,
		projectPath: run.projectPath,
		cwd: run.cwd,
		branch: run.branch,
		base: run.base,
		issue: run.issue,
		pr: run.pr,
		status: run.status,
		phase: run.phase,
		round: run.round,
		cap: review?.cap,
		loop: run.loop,
		blockers: blockerCount(run.findings),
		findings: run.findings,
		escalations: run.escalations,
		humanTouched: run.humanTouched,
		phases: run.steps.map((s) => phaseDigest(run, s)),
		block: run.block,
		handoff: run.handoff,
		error: run.error,
		followUp: !!run.followUp,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt
	};
}

// ---- Loading stored runs ----

// A stored run, made safe to drive: a run written by an older deck or carrying a
// step list from a workflow since removed still loads, with any missing
// collection filled in. One whose current phase no longer exists is blocked
// rather than crashing the runner.
export function normalizeRun(raw: WorkflowRun, now: number): WorkflowRun {
	const run: WorkflowRun = {
		...raw,
		steps: Array.isArray(raw.steps) ? raw.steps : [],
		visits: Array.isArray(raw.visits) ? raw.visits : [],
		findings: Array.isArray(raw.findings) ? raw.findings : [],
		decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
		answers: Array.isArray(raw.answers) ? raw.answers : [],
		failures: raw.failures ?? {},
		escalations: Object.assign({ implementer: false, disagreement: false, cap: false }, raw.escalations),
		epoch: raw.epoch ?? 0,
		round: raw.round ?? 0
	};
	if (!isFinished(run) && !currentStep(run)) blockRun(run, run.phase, `The workflow has no step "${run.phase}" any more.`, now);
	return run;
}
