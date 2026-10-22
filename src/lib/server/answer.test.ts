import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';

const mocks = vi.hoisted(() => ({ pendingId: vi.fn(), resolve: vi.fn(), record: vi.fn(), session: vi.fn(), blockedRun: vi.fn(), runAction: vi.fn(), settled: vi.fn() }));
vi.mock('./ask', () => ({ pendingAskId: mocks.pendingId, resolveAsk: mocks.resolve, wasSettled: mocks.settled }));
vi.mock('./claude', () => ({ recordAnswer: mocks.record }));
vi.mock('./http', async (importOriginal) => ({
	...(await importOriginal<typeof import('./http')>()),
	agentSessionOr404: mocks.session,
	objectBody: (request: Request) => request.json()
}));
vi.mock('./sessions', () => ({ getSession: vi.fn(), deleteSession: vi.fn() }));
vi.mock('./event-log', () => ({ currentLogSeq: () => 7 }));
vi.mock('./workflow-runner', () => ({ blockedRunForSession: mocks.blockedRun, runAction: mocks.runAction }));
const { answerAsk, parseAnswers } = await import('./answer');
const { POST: web } = await import('../../routes/api/sessions/[id]/answer/+server');
const { POST: agent } = await import('../../routes/api/agent/sessions/[id]/answer/+server');

const session = { id: 'example', kind: 'claude' } as DeckSession;
const answers = [{ header: 'Approach', labels: ['Rewrite'] }];

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue(session);
	mocks.resolve.mockReturnValue(true);
});

describe('answerAsk', () => {
	it('records picks against the id the client names', () => {
		answerAsk(session, { text: 'Rewrite', toolUseId: 'toolu_1', answers });
		expect(mocks.record).toHaveBeenCalledWith('example', 'toolu_1', answers);
		expect(mocks.resolve).toHaveBeenCalledWith('example', 'Rewrite');
		answerAsk(session, { text: 'Rewrite', askId: 'toolu_2', answers });
		expect(mocks.record).toHaveBeenLastCalledWith('example', 'toolu_2', answers);
	});
	it('falls back to the pending ask id when the client sends none', () => {
		mocks.pendingId.mockReturnValue('toolu_3');
		answerAsk(session, { text: 'Rewrite', answers });
		expect(mocks.record).toHaveBeenCalledWith('example', 'toolu_3', answers);
	});
	it('answers by text alone without recording', () => {
		expect(answerAsk(session, { text: 'Rewrite' })).toBe(true);
		expect(mocks.record).not.toHaveBeenCalled();
		mocks.pendingId.mockReturnValue(undefined);
		answerAsk(session, { text: 'Rewrite', answers });
		expect(mocks.record).not.toHaveBeenCalled();
	});
	it('turns down an answer for an ask already settled', () => {
		mocks.settled.mockImplementation((_: string, id: string) => id === 'toolu_old');
		expect(answerAsk(session, { text: 'Blue', askId: 'toolu_old', answers })).toBe(false);
		expect(mocks.resolve).not.toHaveBeenCalled();
		expect(mocks.record).not.toHaveBeenCalled();
		// The pending ask's id may still be the previous one while its lookup lags.
		mocks.pendingId.mockReturnValue('toolu_older');
		expect(answerAsk(session, { text: 'Blue', askId: 'toolu_new', answers })).toBe(true);
		expect(mocks.record).toHaveBeenCalledWith('example', 'toolu_new', answers);
	});
	it('rejects an empty answer before touching the ask', () => {
		expect(() => answerAsk(session, { text: '  ' })).toThrow();
		expect(mocks.resolve).not.toHaveBeenCalled();
	});
	it('drops malformed picks rather than failing the answer', () => {
		expect(parseAnswers([{ header: 'A', labels: ['x', 1] }, { labels: [] }, null, 'nope'])).toEqual([{ header: 'A', labels: ['x'] }]);
		expect(parseAnswers('nope')).toBeUndefined();
	});
});

describe('answer routes share one behaviour', () => {
	function post(route: typeof web | typeof agent, body: Record<string, unknown>) {
		return route({ params: { id: 'example' }, request: new Request('http://example.test/answer', { method: 'POST', body: JSON.stringify(body) }) } as Parameters<typeof web>[0] & Parameters<typeof agent>[0]);
	}
	it('persists structured picks from either client', async () => {
		expect(await (await post(web, { text: 'Rewrite', toolUseId: 'toolu_1', answers })).json()).toEqual({ ok: true });
		expect(await (await post(agent, { text: 'Rewrite', askId: 'toolu_1', answers })).json()).toEqual({ ok: true, seq: 7 });
		expect(mocks.record).toHaveBeenCalledTimes(2);
	});
	it('reports a missing ask', async () => {
		mocks.resolve.mockReturnValue(false);
		expect(await (await post(agent, { text: 'late' })).json()).toEqual({ ok: false, reason: 'no-pending-ask' });
		expect(await (await post(web, { text: 'late' })).json()).toEqual({ ok: false });
	});
	it('answers a blocked run only when no session ask is named', async () => {
		mocks.resolve.mockReturnValue(false);
		mocks.blockedRun.mockReturnValue({ id: 'r_1' });
		expect(await (await post(agent, { text: 'Blue', askId: 'toolu_old' })).json()).toEqual({ ok: false, reason: 'no-pending-ask' });
		expect(mocks.runAction).not.toHaveBeenCalled();
		expect(await (await post(agent, { text: 'go on' })).json()).toEqual({ ok: true, seq: 7 });
		expect(mocks.runAction).toHaveBeenCalledWith('r_1', 'answer', { text: 'go on' });
	});
});
