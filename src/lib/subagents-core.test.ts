import { describe, expect, it } from 'vitest';
import {
	agentForCall,
	emptyAgents,
	foldAgents,
	formatDuration,
	hasOmittedReports,
	isLaunchReceipt,
	mayAffectAgents,
	mergeReports,
	runningAgents,
	stopAll,
	withoutOldReports,
	type AgentsState
} from './subagents-core';

const call = (id: string, description = 'Write the docs', name = 'Agent') => ({
	type: 'assistant',
	parent_tool_use_id: null,
	message: { content: [{ type: 'tool_use', id, name, input: { description, run_in_background: true } }] }
});
const started = (task: string, tool: string, extra: Record<string, unknown> = {}) => ({
	type: 'system',
	subtype: 'task_started',
	task_id: task,
	tool_use_id: tool,
	description: 'Write the docs',
	subagent_type: 'general-purpose',
	task_type: 'local_agent',
	is_backgrounded: true,
	...extra
});
const progress = (task: string, description: string, usage = { total_tokens: 51175, tool_uses: 3, duration_ms: 4339 }) => ({
	type: 'system',
	subtype: 'task_progress',
	task_id: task,
	description,
	usage,
	last_tool_name: 'Read'
});
const notified = (task: string, status = 'completed', summary = 'All done.') => ({
	type: 'system',
	subtype: 'task_notification',
	task_id: task,
	status,
	summary
});
const bgList = (...ids: string[]) => ({
	type: 'system',
	subtype: 'background_tasks_changed',
	tasks: ids.map((task_id) => ({ task_id, task_type: 'local_agent' }))
});

function fold(events: Record<string, unknown>[], state: AgentsState = emptyAgents()): AgentsState {
	events.forEach((e, i) => foldAgents(state, e, i));
	return state;
}

describe('foldAgents', () => {
	it('tracks an agent from launch through progress to its report', () => {
		const s = fold([call('toolu_a'), started('t1', 'toolu_a'), progress('t1', 'Reading docs/README.md')]);
		const a = agentForCall(s, 'toolu_a')!;
		expect(a).toMatchObject({
			taskId: 't1',
			callIndex: 0,
			description: 'Write the docs',
			background: true,
			status: 'running',
			activity: 'Reading docs/README.md',
			tokens: 51175,
			toolUses: 3,
			durationMs: 4339
		});
		expect(runningAgents(s).map((t) => t.taskId)).toEqual(['t1']);

		fold(
			[
				{ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed' } },
				{ ...notified('t1'), usage: { total_tokens: 60000, tool_uses: 9, duration_ms: 95000 } }
			],
			s
		);
		expect(a).toMatchObject({ status: 'completed', activity: '', summary: 'All done.', tokens: 60000, toolUses: 9, durationMs: 95000 });
		expect(runningAgents(s)).toEqual([]);
	});

	it('ignores background shells, which are tasks too', () => {
		const s = fold([started('b1', 'toolu_bash', { task_type: 'local_bash', subagent_type: undefined })]);
		expect(s.tasks).toEqual({});
	});

	it('keeps a resumed agent on its first card', () => {
		const s = fold([started('t1', 'toolu_a'), notified('t1'), started('t1', 'toolu_send', { description: 'Rework the docs' })]);
		expect(agentForCall(s, 'toolu_send')).toBe(agentForCall(s, 'toolu_a'));
		expect(agentForCall(s, 'toolu_a')).toMatchObject({ toolUseId: 'toolu_a', status: 'running', summary: '', description: 'Rework the docs' });
	});

	it('maps end states, and reads a failure from the notification', () => {
		const s = fold([started('t1', 'a'), started('t2', 'b'), notified('t1', 'failed', 'Could not build.'), notified('t2', 'killed', '')]);
		expect(s.tasks.t1).toMatchObject({ status: 'failed', summary: 'Could not build.' });
		expect(s.tasks.t2.status).toBe('stopped');
	});

	it('stops a background agent that drops off the running list without a notice', () => {
		const s = fold([started('t1', 'a'), bgList(), started('t2', 'b'), bgList('t1', 't2'), bgList('t2')]);
		expect(s.tasks.t1.status).toBe('stopped');
		expect(s.tasks.t2.status).toBe('running');
	});

	it("doesn't stop an agent the running list hasn't caught up with yet", () => {
		const s = fold([bgList('t0'), started('t1', 'a'), bgList('t0')]);
		expect(s.tasks.t1.status).toBe('running');
	});

	it('stops a foreground agent still running when the turn ends', () => {
		const s = fold([started('f1', 'a', { is_backgrounded: false }), started('t1', 'b'), { type: 'result', subtype: 'success' }]);
		expect(s.tasks.f1.status).toBe('stopped');
		expect(s.tasks.t1.status).toBe('running');
	});

	it("doesn't take a subagent's own result or calls for the main thread's", () => {
		const s = fold([
			started('f1', 'a', { is_backgrounded: false }),
			{ type: 'result', parent_tool_use_id: 'a' },
			{ ...call('toolu_inner'), parent_tool_use_id: 'a' }
		]);
		expect(s.tasks.f1.status).toBe('running');
		expect(s.callIndex.toolu_inner).toBeUndefined();
	});

	it('stops everything on a deck restart or stopAll', () => {
		const s = fold([started('t1', 'a'), { type: 'deck.restart' }]);
		expect(s.tasks.t1.status).toBe('stopped');
		const s2 = fold([started('t2', 'b')]);
		stopAll(s2);
		expect(s2.tasks.t2.status).toBe('stopped');
	});

	it('learns where a call sits even when its start arrived first', () => {
		const s = emptyAgents();
		foldAgents(s, started('t1', 'toolu_a'));
		foldAgents(s, call('toolu_a'), 1234);
		expect(s.tasks.t1.callIndex).toBe(1234);
	});

	it('caps a runaway report', () => {
		const s = fold([started('t1', 'a'), notified('t1', 'completed', 'x'.repeat(50_000))]);
		expect(s.tasks.t1.summary.length).toBe(20_000);
	});

	it('shrugs off junk', () => {
		const s = emptyAgents();
		foldAgents(s, null as never);
		foldAgents(s, progress('nope', 'x'));
		foldAgents(s, { type: 'system', subtype: 'background_tasks_changed', tasks: 'x' });
		expect(s.tasks).toEqual({});
	});
});

describe('mayAffectAgents', () => {
	it('passes every line the fold reads, as claude writes them', () => {
		for (const e of [call('a'), started('t', 'a'), progress('t', 'x'), notified('t'), bgList('t'), { type: 'result' }, { type: 'deck.restart' }]) {
			expect(mayAffectAgents(JSON.stringify(e)), JSON.stringify(e)).toBe(true);
		}
	});
	it('skips ordinary traffic', () => {
		expect(mayAffectAgents(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toBe(false);
		expect(mayAffectAgents(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }))).toBe(false);
	});
});

describe('helpers', () => {
	it('recognises a background launch receipt', () => {
		expect(isLaunchReceipt('Async agent launched successfully. (internal)')).toBe(true);
		expect(isLaunchReceipt('Here is the report')).toBe(false);
	});
	it('formats durations', () => {
		expect(formatDuration(4339)).toBe('4s');
		expect(formatDuration(252_000)).toBe('4m 12s');
		expect(formatDuration(3_720_000)).toBe('1h 2m');
	});
});

describe('withoutOldReports / mergeReports', () => {
	it('drops only finished reports from before the window, and merges them back', () => {
		const s = emptyAgents();
		foldAgents(s, call('old'), 10);
		foldAgents(s, started('t1', 'old'));
		foldAgents(s, notified('t1', 'completed', 'old report'));
		foldAgents(s, call('new'), 500);
		foldAgents(s, started('t2', 'new'));
		foldAgents(s, notified('t2', 'completed', 'new report'));
		foldAgents(s, started('t3', 'unknown'));
		const slim = withoutOldReports(s, 400);
		expect(slim.tasks.t1).toMatchObject({ summary: '', reportOmitted: true });
		expect(slim.tasks.t2.summary).toBe('new report');
		expect(slim.tasks.t3.reportOmitted).toBeUndefined();
		expect(s.tasks.t1.summary).toBe('old report');
		expect(hasOmittedReports(slim)).toBe(true);
		mergeReports(slim, s);
		expect(slim.tasks.t1).toMatchObject({ summary: 'old report', reportOmitted: false });
		expect(hasOmittedReports(slim)).toBe(false);
	});
});
