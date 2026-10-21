import { describe, expect, it } from 'vitest';
import { backgroundTaskCount, teardownDecision, BACKGROUND_HOLD_MS } from './idle-teardown-core';

describe('backgroundTaskCount', () => {
	it('counts the tasks in a background_tasks_changed event', () => {
		const tasks = [{ task_id: 'a', task_type: 'local_agent' }, { task_id: 'b', task_type: 'local_bash' }];
		expect(backgroundTaskCount({ type: 'system', subtype: 'background_tasks_changed', tasks })).toBe(2);
	});

	it('reads an empty list as zero', () => {
		expect(backgroundTaskCount({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toBe(0);
	});

	it('treats a missing or malformed list as zero', () => {
		expect(backgroundTaskCount({ type: 'system', subtype: 'background_tasks_changed' })).toBe(0);
		expect(backgroundTaskCount({ type: 'system', subtype: 'background_tasks_changed', tasks: 'x' })).toBe(0);
	});

	// A background Agent/Task subagent is a local_agent entry in the same live list.
	const subagent = { task_id: 't1', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Watch the build' };

	it('counts a background subagent', () => {
		expect(backgroundTaskCount({ type: 'system', subtype: 'background_tasks_changed', tasks: [subagent] })).toBe(1);
	});

	it('ignores the subagent edge events, which repeat what the list says', () => {
		expect(backgroundTaskCount({ type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_agent', is_backgrounded: true })).toBeUndefined();
		expect(backgroundTaskCount({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' })).toBeUndefined();
	});

	it('ignores other events', () => {
		expect(backgroundTaskCount({ type: 'system', subtype: 'task_started' })).toBeUndefined();
		expect(backgroundTaskCount({ type: 'result', subtype: 'success' })).toBeUndefined();
	});
});

describe('teardownDecision', () => {
	const idleSince = 1_000_000;

	it('kills an idle process with no background work', () => {
		expect(teardownDecision({ running: false, backgroundTasks: 0, idleSince, now: idleSince + 1 })).toEqual({
			action: 'kill'
		});
	});

	it('leaves a running turn alone', () => {
		expect(teardownDecision({ running: true, backgroundTasks: 0, idleSince, now: idleSince })).toEqual({
			action: 'skip'
		});
	});

	it('waits while background work is still going, until the hold cap', () => {
		const now = idleSince + 20 * 60 * 1000;
		expect(teardownDecision({ running: false, backgroundTasks: 2, idleSince, now })).toEqual({
			action: 'wait',
			ms: BACKGROUND_HOLD_MS - 20 * 60 * 1000
		});
	});

	it('kills once the hold cap is reached, even with background work', () => {
		const now = idleSince + BACKGROUND_HOLD_MS;
		expect(teardownDecision({ running: false, backgroundTasks: 1, idleSince, now })).toEqual({ action: 'kill' });
	});

	it('keeps an idle process alive for a background subagent, then kills it once the subagent leaves the list', () => {
		const now = idleSince + 20 * 60 * 1000;
		const tasks = (list: unknown[]) => backgroundTaskCount({ type: 'system', subtype: 'background_tasks_changed', tasks: list })!;
		const subagent = { task_id: 't1', task_type: 'local_agent', subagent_type: 'general-purpose' };
		expect(teardownDecision({ running: false, backgroundTasks: tasks([subagent]), idleSince, now }).action).toBe('wait');
		expect(teardownDecision({ running: false, backgroundTasks: tasks([]), idleSince, now })).toEqual({ action: 'kill' });
	});

	it('leaves a turn with a foreground subagent alone: the turn is still running', () => {
		expect(teardownDecision({ running: true, backgroundTasks: 0, idleSince, now: idleSince + BACKGROUND_HOLD_MS })).toEqual({
			action: 'skip'
		});
	});

	it('honours a custom hold', () => {
		expect(teardownDecision({ running: false, backgroundTasks: 1, idleSince, now: idleSince + 5, holdMs: 10 })).toEqual({
			action: 'wait',
			ms: 5
		});
	});
});
