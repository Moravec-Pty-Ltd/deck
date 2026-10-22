import { describe, expect, it } from 'vitest';
import { activityEntries, formatCountdown, visibleEntries } from './activity-core';
import type { AgentState } from './subagents-core';
import type { Watch } from './watches';

const watch = (id: string, createdAt: number): Watch => ({
	id,
	sessionId: 's',
	title: id,
	prompt: '',
	createdAt,
	dueAt: createdAt + 1000,
	state: 'active'
});
const agent = (taskId: string) => ({ taskId }) as AgentState;

describe('activityEntries', () => {
	it('merges watches and agents newest first', () => {
		const start: Record<string, number> = { a1: 150, a2: 50 };
		const list = activityEntries([watch('w1', 100), watch('w2', 200)], [agent('a1'), agent('a2')], (a) => start[a.taskId]);
		expect(list.map((e) => e.key)).toEqual(['w:w2', 'a:a1', 'w:w1', 'a:a2']);
	});
});

describe('visibleEntries', () => {
	const entries = activityEntries([1, 2, 3, 4, 5].map((n) => watch(`w${n}`, n)), [], () => 0);
	it('caps at three with a count of the rest', () => {
		const { shown, more } = visibleEntries(entries, false);
		expect(shown).toHaveLength(3);
		expect(more).toBe(2);
	});
	it('shows everything when expanded or small', () => {
		expect(visibleEntries(entries, true)).toEqual({ shown: entries, more: 0 });
		expect(visibleEntries(entries.slice(0, 3), false).more).toBe(0);
	});
});

describe('formatCountdown', () => {
	it('formats', () => {
		expect(formatCountdown(0)).toBe('due');
		expect(formatCountdown(-5)).toBe('due');
		expect(formatCountdown(4 * 60_000 + 12_000)).toBe('4m 12s');
		expect(formatCountdown(63 * 60_000)).toBe('1h 3m');
		expect(formatCountdown(500)).toBe('1s');
	});
});
