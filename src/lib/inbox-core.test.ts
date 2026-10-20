import { describe, it, expect } from 'vitest';
import type { SessionView } from '$lib/session-view';
import { answerRequest, askBlock, inboxGroups, toRow, touchesInbox, type InboxAsk } from './inbox-core';

function session(id: string, over: Partial<SessionView> = {}): SessionView {
	return {
		id,
		url: `http://example.test/s/${id}`,
		kind: 'claude',
		title: '',
		cwd: '/path/to/acme',
		status: 'running',
		awaitingInput: true,
		createdAt: 0,
		lastActiveAt: 0,
		...over
	};
}

const q = { question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] };

function mcp(sessionId: string, askedAt: number, askId?: string): InboxAsk {
	return { source: 'mcp', sessionId, askedAt, questions: [q], ...(askId ? { askId } : {}) };
}

function run(runId: string, askedAt: number): InboxAsk {
	return {
		source: 'run',
		runId,
		sessionId: 's9',
		askedAt,
		questions: [{ question: 'Which branch?', header: 'Fix the login bug', options: [] }]
	};
}

describe('inboxGroups', () => {
	it('puts session questions before blocked runs, longest waiting first', () => {
		const groups = inboxGroups([run('r1', 5), mcp('b', 30), mcp('a', 10), run('r2', 1)], []);
		expect(groups.map((g) => g.id)).toEqual(['sessions', 'runs']);
		expect(groups[0].rows.map((r) => r.href)).toEqual(['/s/a', '/s/b']);
		expect(groups[1].rows.map((r) => r.href)).toEqual(['/runs/r2', '/runs/r1']);
	});

	it('drops empty groups', () => {
		expect(inboxGroups([run('r1', 1)], []).map((g) => g.id)).toEqual(['runs']);
		expect(inboxGroups([], [])).toEqual([]);
	});
});

describe('toRow', () => {
	it('names a session by its title, then its folder, then its id', () => {
		expect(toRow(mcp('a', 1), [session('a', { title: 'Refactor auth' })]).title).toBe('Refactor auth');
		expect(toRow(mcp('a', 1), [session('a')]).title).toBe('acme');
		expect(toRow(mcp('a', 1), []).title).toBe('a');
	});

	it('names a run by its title and links to the run', () => {
		const row = toRow(run('r1', 1), []);
		expect(row).toMatchObject({ title: 'Fix the login bug', subtitle: 'Workflow run', href: '/runs/r1' });
	});

	it('keys a new ask on the same session apart from the old one', () => {
		expect(toRow(mcp('a', 1, 't1'), []).key).not.toBe(toRow(mcp('a', 2, 't2'), []).key);
	});

	it('escapes ids in links', () => {
		expect(toRow(mcp('a b', 1), []).href).toBe('/s/a%20b');
	});
});

describe('askBlock', () => {
	it('wraps the questions the way the ask card reads them', () => {
		expect(askBlock(mcp('a', 1))).toEqual({ input: { questions: [q] } });
	});

	it('drops a run question header, which repeats the row title', () => {
		expect(askBlock(run('r1', 1)).input.questions).toEqual([{ question: 'Which branch?', options: [] }]);
	});
});

describe('answerRequest', () => {
	const picks = [{ header: 'Ship', labels: ['Yes'] }];

	it('answers a session ask with the text, the picks and the ask id', () => {
		expect(answerRequest(mcp('a', 1, 't1'), 'Answering', picks)).toEqual({
			url: '/api/agent/sessions/a/answer',
			body: { text: 'Answering', answers: picks, askId: 't1' }
		});
	});

	it('leaves the ask id out when the server has not learnt it', () => {
		expect(answerRequest(mcp('a', 1), 'Answering', picks).body).not.toHaveProperty('askId');
	});

	it('answers a run with what was typed, through the run route', () => {
		const typed = [{ header: 'Fix the login bug', labels: ['use main'] }];
		expect(answerRequest(run('r1', 1), 'Answering your question:\n- x', typed)).toEqual({
			url: '/api/agent/runs/r1/answer',
			body: { text: 'use main' }
		});
	});
});

describe('touchesInbox', () => {
	const ev = (type: string) => ({ seq: 1, type, sessionId: 'a', at: 0 });

	it('refetches on a snapshot', () => {
		expect(touchesInbox({ snapshot: [], seq: 1 })).toBe(true);
	});

	it('refetches on an ask or run change only', () => {
		for (const type of ['awaiting-input', 'run-updated', 'run-deleted', 'session-deleted'])
			expect(touchesInbox({ events: [ev(type)], seq: 1 })).toBe(true);
		expect(touchesInbox({ events: [ev('status'), ev('pr')], seq: 1 })).toBe(false);
		expect(touchesInbox({ events: [], seq: 1 })).toBe(false);
	});
});
