import { describe, expect, it, vi } from 'vitest';

const sessions = vi.hoisted(() => new Map([
	['c_1', { id: 'c_1', kind: 'claude', title: 'Boss' }],
	['t_1', { id: 't_1', kind: 'shell', title: 'sh' }]
]));
vi.mock('./store', () => ({ getStoredSession: (id: string) => sessions.get(id), listProjects: () => [] }));
vi.mock('./config', () => ({ baseUrl: 'http://localhost:4818' }));
vi.mock('./create-session', () => ({ parseIssue: () => null, parsePr: () => null }));
vi.mock('./workflow-exec', () => ({}));
vi.mock('./workflow-store', () => ({ listRuns: () => [] }));

const { digest, parseStartRequest } = await import('./workflow-api');
const { BUILTIN_WORKFLOWS, newRun } = await import('./workflow-core');

const parse = (startedBy: unknown) => parseStartRequest({ cwd: '/p', startedBy }).startedBy;

describe('startedBy', () => {
	it('takes an agent session, a person, or nothing', () => {
		expect(parse({ sessionId: 'c_1' })).toEqual({ sessionId: 'c_1' });
		expect(parse({ human: true })).toEqual({ human: true });
		expect(parse(undefined)).toBeUndefined();
	});

	it.each([{ sessionId: 'nope' }, { sessionId: 't_1' }, { sessionId: 'c_1', human: true }, { human: false }, {}, 'c_1'])('refuses %j', (v) => {
		expect(() => parse(v)).toThrow(expect.objectContaining({ status: 400 }));
	});

	it('digests the session title until the session is deleted', () => {
		const run = newRun({ id: 'r_1', def: BUILTIN_WORKFLOWS[0], projectPath: '/p', cwd: '/w', branch: 'x', title: '#1', profile: { loop: false }, startedBy: { sessionId: 'c_1' }, now: 0 });
		expect(digest(run).startedBy).toEqual({ sessionId: 'c_1', title: 'Boss' });
		run.startedBy = { sessionId: 'gone' };
		expect(digest(run).startedBy).toEqual({ sessionId: 'gone', title: undefined });
	});
});
