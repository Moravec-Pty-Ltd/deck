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

	it('honours a custom hold', () => {
		expect(teardownDecision({ running: false, backgroundTasks: 1, idleSince, now: idleSince + 5, holdMs: 10 })).toEqual({
			action: 'wait',
			ms: 5
		});
	});
});
