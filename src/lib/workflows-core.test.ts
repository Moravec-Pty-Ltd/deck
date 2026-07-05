import { describe, expect, it } from 'vitest';
import type { Project, Workflow, WorkflowRun, WorkflowStep } from '$lib/types';
import {
	capOutput,
	expandStepTokens,
	firstAgentPrompt,
	isLegacyWorkflowId,
	LEGACY_NEW_ID,
	LEGACY_REVIEW_ID,
	nextAfter,
	parseWorkflows,
	resolveWorkflows,
	retryPrompt,
	runStepsSnapshot,
	viewRun
} from './workflows-core';

const devWorkflow: Workflow = {
	id: 'dev',
	name: 'Dev',
	context: 'issue',
	steps: [
		{ type: 'agent', name: 'implement', prompt: 'Work [issue_id]: [issue_body]' },
		{ type: 'gate', name: 'check', command: 'pnpm check && pnpm test', retries: 2 },
		{ type: 'run', name: 'pr', command: 'gh pr create --fill' }
	]
};

describe('parseWorkflows', () => {
	it('accepts a valid config', () => {
		expect(parseWorkflows([devWorkflow])).toEqual([devWorkflow]);
	});

	it('rejects an empty step list', () => {
		expect(() => parseWorkflows([{ ...devWorkflow, steps: [] }])).toThrow();
	});

	it('rejects duplicate workflow ids', () => {
		expect(() => parseWorkflows([devWorkflow, { ...devWorkflow, name: 'Dev 2' }])).toThrow(
			/duplicate workflow id/
		);
	});

	it('rejects duplicate step names within a workflow', () => {
		const steps: WorkflowStep[] = [
			{ type: 'run', name: 'x', command: 'true' },
			{ type: 'ask', name: 'x', question: 'ok?' }
		];
		expect(() => parseWorkflows([{ ...devWorkflow, steps }])).toThrow(/duplicate step name/);
	});

	it('rejects step names that would break the [step:] token', () => {
		const steps: WorkflowStep[] = [{ type: 'run', name: 'a]b', command: 'true' }];
		expect(() => parseWorkflows([{ ...devWorkflow, steps }])).toThrow();
	});

	it('rejects an unknown step type and bad retries', () => {
		expect(() =>
			parseWorkflows([{ ...devWorkflow, steps: [{ type: 'loop', name: 'x' }] }])
		).toThrow();
		expect(() =>
			parseWorkflows([
				{ ...devWorkflow, steps: [{ type: 'gate', name: 'g', command: 'true', retries: -1 }] }
			])
		).toThrow();
	});
});

describe('resolveWorkflows', () => {
	const project: Project = { name: 'p', path: '/path/to/project' };

	it('returns configured workflows when present', () => {
		expect(resolveWorkflows({ ...project, workflows: [devWorkflow] })).toEqual([devWorkflow]);
	});

	it('synthesizes the legacy pair from template/reviewPrompt', () => {
		const list = resolveWorkflows({ ...project, template: 'do [issue_id]', reviewPrompt: 'review [pr_url]' });
		expect(list.map((w) => w.id)).toEqual([LEGACY_NEW_ID, LEGACY_REVIEW_ID]);
		expect(list[0].context).toBe('issue');
		expect(firstAgentPrompt(list[0])).toBe('do [issue_id]');
		expect(list[1].context).toBe('pr');
		expect(firstAgentPrompt(list[1])).toBe('review [pr_url]');
	});

	it('synthesizes empty prompts for a bare project and for no project', () => {
		for (const p of [project, undefined]) {
			const list = resolveWorkflows(p);
			expect(list).toHaveLength(2);
			expect(list.every((w) => firstAgentPrompt(w) === '')).toBe(true);
		}
	});

	it('marks only the synthesized ids as legacy', () => {
		expect(isLegacyWorkflowId(LEGACY_NEW_ID)).toBe(true);
		expect(isLegacyWorkflowId(LEGACY_REVIEW_ID)).toBe(true);
		expect(isLegacyWorkflowId('dev')).toBe(false);
	});
});

describe('expandStepTokens', () => {
	it('substitutes captured outputs and blanks unknown steps', () => {
		const out = expandStepTokens('diff:\n[step:diff]\nmissing:[step:nope]', { diff: '+1 -2' });
		expect(out).toBe('diff:\n+1 -2\nmissing:');
	});

	it('does not re-expand tokens inside an inserted output', () => {
		const out = expandStepTokens('[step:a]', { a: 'literal [step:b]', b: 'X' });
		expect(out).toBe('literal [step:b]');
	});
});

describe('nextAfter', () => {
	const steps = devWorkflow.steps;

	it('advances on success and finishes after the last step', () => {
		expect(nextAfter(steps, 0, true, {})).toEqual({ kind: 'goto', step: 1 });
		expect(nextAfter(steps, 2, true, {})).toEqual({ kind: 'done' });
	});

	it('sends a failed gate back to the nearest preceding agent step', () => {
		expect(nextAfter(steps, 1, false, {})).toEqual({
			kind: 'goto',
			step: 0,
			retry: { gate: 1, attempt: 1, max: 2 }
		});
	});

	it('counts consumed retries and pauses once the budget is exhausted', () => {
		expect(nextAfter(steps, 1, false, { 1: 1 })).toMatchObject({
			kind: 'goto',
			retry: { attempt: 2, max: 2 }
		});
		expect(nextAfter(steps, 1, false, { 1: 2 })).toEqual({
			kind: 'pause',
			reason: 'gate "check" failed after 3 attempts'
		});
	});

	it('pauses a failed gate with no preceding agent step', () => {
		const orphan: WorkflowStep[] = [{ type: 'gate', name: 'g', command: 'false' }];
		expect(nextAfter(orphan, 0, false, {})).toEqual({
			kind: 'pause',
			reason: 'gate "g" failed (no agent step to retry)'
		});
	});

	it('retries a default gate once', () => {
		const defaulted: WorkflowStep[] = [
			{ type: 'agent', name: 'a', prompt: 'p' },
			{ type: 'gate', name: 'g', command: 'false' }
		];
		expect(nextAfter(defaulted, 1, false, {})).toMatchObject({ kind: 'goto', step: 0 });
		expect(nextAfter(defaulted, 1, false, { 1: 1 })).toMatchObject({ kind: 'pause' });
	});

	it('pauses on a failed run or agent step', () => {
		expect(nextAfter(steps, 2, false, {})).toEqual({ kind: 'pause', reason: 'step "pr" failed' });
		expect(nextAfter(steps, 0, false, {})).toEqual({
			kind: 'pause',
			reason: 'step "implement" failed'
		});
	});

	it('pauses on an out-of-range index', () => {
		expect(nextAfter(steps, 9, true, {})).toEqual({ kind: 'pause', reason: 'step out of range' });
	});
});

describe('retryPrompt / capOutput', () => {
	it('keeps the tail of oversized output', () => {
		const capped = capOutput('a'.repeat(9000));
		expect(capped).toHaveLength(8001);
		expect(capped.startsWith('…')).toBe(true);
	});

	it('names the gate and the attempt, and survives empty output', () => {
		const p = retryPrompt('check', '', 1, 2);
		expect(p).toContain('gate "check" failed (retry 1 of 2)');
		expect(p).toContain('(no output)');
	});
});

describe('viewRun', () => {
	const run: WorkflowRun = {
		workflowId: 'dev',
		name: 'Dev',
		steps: runStepsSnapshot(devWorkflow),
		step: 1,
		status: 'running',
		startedAt: 1
	};

	it('passes a live run through untouched', () => {
		expect(viewRun(run, true)).toBe(run);
	});

	it('downgrades a stale in-flight run to paused', () => {
		expect(viewRun(run, false)).toMatchObject({ status: 'paused', reason: 'server restarted mid-run' });
		expect(viewRun({ ...run, status: 'awaiting-input' }, false)).toMatchObject({ status: 'paused' });
	});

	it('leaves terminal states alone', () => {
		const done = { ...run, status: 'done' as const };
		expect(viewRun(done, false)).toBe(done);
	});
});
