import { describe, it, expect } from 'vitest';
import type { InboxAsk } from '$lib/inbox-core';
import type { SessionView } from '$lib/session-view';
import { inShell, shellSync } from './shell';

const q = (question: string) => ({ question, options: [{ label: 'Yes' }] });
const ask = (sessionId: string, askedAt: number, question = 'Ship it?'): InboxAsk => ({
	source: 'mcp',
	sessionId,
	questions: [q(question)],
	askedAt
});
const sessions = [{ id: 'a', title: 'Fix login', cwd: '/path/to/acme' } as SessionView];

function fake() {
	const calls: [string, Record<string, unknown> | undefined][] = [];
	const invoke = (<T>(cmd: string, args?: Record<string, unknown>) => {
		calls.push([cmd, args]);
		return Promise.resolve(undefined as T);
	}) as Parameters<typeof shellSync>[0];
	return { calls, sync: shellSync(invoke), sent: (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a) };
}

describe('shell bridge', () => {
	it('is off in a normal browser', () => {
		expect(inShell).toBe(false);
	});

	it('hands the tray every waiting row', () => {
		const { sync, sent } = fake();
		sync([ask('a', 1), { source: 'run', runId: 'r1', questions: [q('Go?')], askedAt: 2 }], sessions);
		expect(sent('set_attention')).toEqual([
			{ items: [{ title: 'Fix login', href: '/s/a' }, { title: 'Workflow run', href: '/runs/r1' }] }
		]);
	});

	it('notifies only asks that arrive after the first load, tagged by session', () => {
		const { sync, sent } = fake();
		sync([ask('a', 1)], sessions);
		expect(sent('notify')).toEqual([]);
		sync([ask('a', 1), ask('b', 2, 'Merge?')], sessions);
		expect(sent('notify')).toEqual([{ tag: '/s/b', title: 'b', body: 'Merge?', href: '/s/b' }]);
		// A second ask for the same session carries the same tag, so the shell replaces it.
		sync([ask('a', 1), ask('b', 3, 'Rebase?')], sessions);
		expect(sent('notify').at(-1)).toEqual({ tag: '/s/b', title: 'b', body: 'Rebase?', href: '/s/b' });
		expect(sent('set_attention').at(-1)).toEqual({
			items: [{ title: 'Fix login', href: '/s/a' }, { title: 'b', href: '/s/b' }]
		});
	});

	it('clears the tray when nothing waits', () => {
		const { sync, sent } = fake();
		sync([ask('a', 1)], sessions);
		sync([], sessions);
		expect(sent('set_attention').at(-1)).toEqual({ items: [] });
	});
});
