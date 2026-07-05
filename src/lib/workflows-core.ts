import { z } from 'zod';
import type { Project, Workflow, WorkflowRun, WorkflowRunStep, WorkflowStep } from '$lib/types';

// Pure workflow logic (issue #111): config validation, legacy synthesis, step
// tokens, and the step-advance state machine. Node-free so it is unit-testable
// and importable from the browser (the new-session modal resolves workflows
// client-side); the IO-heavy runner lives in server/workflows.ts.

// Step names become [step:<name>] tokens, so keep them bracket-free; ids ride
// in API bodies and DOM keys, so keep them to a safe slug charset.
const NAME_RE = /^[^[\]]+$/;
const ID_RE = /^[\w-]+$/;

const runStepSchema = z.object({
	type: z.literal('run'),
	name: z.string().min(1).regex(NAME_RE),
	command: z.string().min(1)
});

const agentStepSchema = z.object({
	type: z.literal('agent'),
	name: z.string().min(1).regex(NAME_RE),
	prompt: z.string().min(1),
	model: z.string().min(1).optional()
});

const gateStepSchema = z.object({
	type: z.literal('gate'),
	name: z.string().min(1).regex(NAME_RE),
	command: z.string().min(1),
	retries: z.number().int().min(0).max(10).optional()
});

const askStepSchema = z.object({
	type: z.literal('ask'),
	name: z.string().min(1).regex(NAME_RE),
	question: z.string().min(1)
});

const stepSchema = z.discriminatedUnion('type', [
	runStepSchema,
	agentStepSchema,
	gateStepSchema,
	askStepSchema
]);

const workflowSchema = z.object({
	id: z.string().min(1).regex(ID_RE),
	name: z.string().min(1),
	context: z.enum(['issue', 'pr', 'worktree', 'none']),
	steps: z.array(stepSchema).min(1)
});

const workflowsSchema = z.array(workflowSchema).max(50);

// Duplicate step names would make [step:<name>] ambiguous; duplicate workflow
// ids would make the start-run lookup ambiguous.
function assertUnique(workflows: Workflow[]) {
	const ids = new Set<string>();
	for (const w of workflows) {
		if (ids.has(w.id)) throw new Error(`duplicate workflow id: ${w.id}`);
		ids.add(w.id);
		const names = new Set<string>();
		for (const s of w.steps) {
			if (names.has(s.name)) throw new Error(`duplicate step name in "${w.name}": ${s.name}`);
			names.add(s.name);
		}
	}
}

// Validate raw workflows config (throws on schema mismatch or duplicate
// id/step name). Used by the projects API on write.
export function parseWorkflows(raw: unknown): Workflow[] {
	const workflows = workflowsSchema.parse(raw) as Workflow[];
	assertUnique(workflows);
	return workflows;
}

// Ids of the two workflows synthesized from the legacy template/reviewPrompt
// fields. The modal never sends these to the start-run path, which is what
// keeps projects without configured workflows on the exact pre-workflow
// behaviour (plain maybeDispatch, no run state).
export const LEGACY_NEW_ID = 'legacy-new';
export const LEGACY_REVIEW_ID = 'legacy-review';

export function isLegacyWorkflowId(id: string): boolean {
	return id === LEGACY_NEW_ID || id === LEGACY_REVIEW_ID;
}

// The workflows a project offers: its configured list when present, else the
// two single-agent-step defaults synthesized from the legacy fields (an empty
// template means an empty prompt field, exactly like today). Accepts undefined
// so a custom-path session (no registered project) still gets the defaults.
export function resolveWorkflows(project: Project | undefined): Workflow[] {
	if (project?.workflows?.length) return project.workflows;
	return [
		{
			id: LEGACY_NEW_ID,
			name: 'New',
			context: 'issue',
			steps: [{ type: 'agent', name: 'Prompt', prompt: project?.template ?? '' }]
		},
		{
			id: LEGACY_REVIEW_ID,
			name: 'Review',
			context: 'pr',
			steps: [{ type: 'agent', name: 'Prompt', prompt: project?.reviewPrompt ?? '' }]
		}
	];
}

// The prompt the new-session modal prefills: the first agent step's prompt
// (the step a create-time prompt edit overrides), or '' for a workflow with no
// agent steps.
export function firstAgentPrompt(workflow: Workflow): string {
	const step = workflow.steps.find((s) => s.type === 'agent');
	return step?.type === 'agent' ? step.prompt : '';
}

// Substitute [step:<name>] tokens with captured step outputs. Runs *after*
// expandPlaceholders so text inside an inserted output is never re-expanded
// (mirroring that function's single-pass guarantee). A step that hasn't run
// resolves to '' like any other empty token.
export function expandStepTokens(text: string, outputs: Record<string, string>): string {
	return text.replace(/\[step:([^\]]+)\]/g, (_, name: string) => outputs[name] ?? '');
}

// POSIX single-quote a value for interpolation into a run/gate command.
// Command tokens carry remote-authored text (issue bodies, agent output), so
// they must land as inert shell words, never as syntax.
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// A gate with no explicit retry budget feeds back to the agent once before
// pausing; 0 opts a gate out of the retry loop entirely.
const DEFAULT_GATE_RETRIES = 1;

// What the runner should do after a step settles. 'goto' moves execution to
// steps[step] (forward on success, back to an agent step on a gate failure,
// with `retry` carrying the feedback prompt's ingredients).
export type NextAction =
	| { kind: 'goto'; step: number; retry?: { gate: number; attempt: number; max: number } }
	| { kind: 'done' }
	| { kind: 'pause'; reason: string };

function nearestAgentBefore(steps: WorkflowStep[], index: number): number {
	for (let i = index - 1; i >= 0; i--) {
		if (steps[i].type === 'agent') return i;
	}
	return -1;
}

function afterGateFailure(
	steps: WorkflowStep[],
	index: number,
	attempts: Record<number, number>
): NextAction {
	const gate = steps[index] as Extract<WorkflowStep, { type: 'gate' }>;
	const max = gate.retries ?? DEFAULT_GATE_RETRIES;
	const agent = nearestAgentBefore(steps, index);
	if (agent < 0) return { kind: 'pause', reason: `gate "${gate.name}" failed (no agent step to retry)` };
	const attempt = (attempts[index] ?? 0) + 1;
	if (attempt > max) {
		return { kind: 'pause', reason: `gate "${gate.name}" failed after ${max + 1} attempt${max ? 's' : ''}` };
	}
	return { kind: 'goto', step: agent, retry: { gate: index, attempt, max } };
}

// The pure step-advance: given the workflow's steps, the index of the step
// that just settled, whether it succeeded, and the per-gate retry counters,
// decide what happens next. `attempts[gateIndex]` counts retries already
// consumed by that gate (the caller increments it when acting on `retry`).
// Budgets are deliberately cumulative for the whole run, never reset by a
// later pass: they bound total looping, not per-visit patience.
export function nextAfter(
	steps: WorkflowStep[],
	index: number,
	ok: boolean,
	attempts: Record<number, number>
): NextAction {
	const step = steps[index];
	if (!step) return { kind: 'pause', reason: 'step out of range' };
	if (ok) {
		return index + 1 < steps.length ? { kind: 'goto', step: index + 1 } : { kind: 'done' };
	}
	if (step.type === 'gate') return afterGateFailure(steps, index, attempts);
	return { kind: 'pause', reason: `step "${step.name}" failed` };
}

// Cap embedded command output so a chatty gate can't balloon a retry prompt or
// the stored reason; keep the tail, where the actual errors land.
export function capOutput(output: string, max = 8000): string {
	if (output.length <= max) return output;
	return `…${output.slice(-max)}`;
}

// The prompt an agent step is re-run with after a gate failure: the failure
// output with a short preamble. The original task prompt is already in the
// session transcript, so repeating it would only pad the context.
export function retryPrompt(gateName: string, output: string, attempt: number, max: number): string {
	const capped = capOutput(output).trim() || '(no output)';
	return `The gate "${gateName}" failed (retry ${attempt} of ${max}). Output:\n\n${capped}\n\nFix the issues; the gate will run again when you finish.`;
}

// Step descriptors snapshotted onto the run at start (see WorkflowRun.steps).
export function runStepsSnapshot(workflow: Workflow): WorkflowRunStep[] {
	return workflow.steps.map((s) => ({ name: s.name, type: s.type }));
}

// A stored run that claims to be in flight but has no live runner (the server
// restarted, or an old server wrote it) surfaces as paused instead of
// pretending to progress. Terminal states pass through untouched.
export function viewRun(run: WorkflowRun | undefined, live: boolean): WorkflowRun | undefined {
	if (!run || live) return run;
	if (run.status !== 'running' && run.status !== 'awaiting-input') return run;
	return { ...run, status: 'paused', reason: 'server restarted mid-run' };
}
