import { describe, it, expect } from 'vitest';
import type { SessionView } from '$lib/session-view';
import {
	applyEvents,
	applyResponse,
	applySnapshot,
	backoffMs,
	cursorWentBack,
	feedUrl,
	readFeed,
	type FeedEvent
} from './session-feed-core';

function row(id: string, over: Partial<SessionView> = {}): SessionView {
	return {
		id,
		url: `http://example.test/s/${id}`,
		kind: 'claude',
		title: id,
		cwd: '/path/to/project',
		status: 'idle',
		awaitingInput: false,
		createdAt: 0,
		lastActiveAt: 0,
		...over
	};
}

function ev(seq: number, type: string, sessionId: string, payload: Record<string, unknown> = {}): FeedEvent {
	return { seq, type, sessionId, at: 1000 + seq, ...payload };
}

const base = () => applySnapshot([row('a', { lastActiveAt: 5 }), row('b', { lastActiveAt: 9 })], 10);

describe('applySnapshot', () => {
	it('orders newest activity first and takes the cursor', () => {
		const s = base();
		expect(s.sessions.map((x) => x.id)).toEqual(['b', 'a']);
		expect(s.seq).toBe(10);
	});
});

describe('applyEvents', () => {
	it('patches status and bumps lastActiveAt, reordering the list', () => {
		const s = applyEvents(base(), [ev(11, 'status', 'a', { status: 'running' })]);
		expect(s.sessions[0]).toMatchObject({ id: 'a', status: 'running', lastActiveAt: 1011 });
		expect(s.seq).toBe(11);
	});

	it('ignores an unknown status value', () => {
		const s = applyEvents(base(), [ev(11, 'status', 'a', { status: 'exploded' })]);
		expect(s.sessions.find((x) => x.id === 'a')?.status).toBe('idle');
	});

	it('skips events at or below the cursor (repeats and snapshot overlap)', () => {
		const s = applyEvents(base(), [ev(10, 'session-deleted', 'a'), ev(9, 'session-deleted', 'b')]);
		expect(s.sessions).toHaveLength(2);
		expect(s.seq).toBe(10);
	});

	it('applies the same batch twice without change', () => {
		const batch = [ev(11, 'status', 'a', { status: 'running' }), ev(12, 'awaiting-input', 'a', { awaitingInput: true })];
		const once = applyEvents(base(), batch);
		expect(applyEvents(once, batch)).toBe(once);
	});

	it('folds out-of-order events in seq order', () => {
		const s = applyEvents(base(), [
			ev(13, 'status', 'a', { status: 'idle' }),
			ev(11, 'status', 'a', { status: 'running' })
		]);
		expect(s.sessions.find((x) => x.id === 'a')?.status).toBe('idle');
		expect(s.seq).toBe(13);
	});

	it('inserts a created session and replaces one it already has', () => {
		const created = row('c', { lastActiveAt: 50, title: 'new' });
		let s = applyEvents(base(), [ev(11, 'session-created', 'c', { session: created })]);
		expect(s.sessions.map((x) => x.id)).toEqual(['c', 'b', 'a']);
		s = applyEvents(s, [ev(12, 'session-created', 'c', { session: { ...created, title: 'again' } })]);
		expect(s.sessions.filter((x) => x.id === 'c')).toEqual([{ ...created, title: 'again' }]);
	});

	it('ignores a created event without a session', () => {
		expect(applyEvents(base(), [ev(11, 'session-created', 'c')]).sessions).toHaveLength(2);
	});

	it('removes a deleted session', () => {
		const s = applyEvents(base(), [ev(11, 'session-deleted', 'a')]);
		expect(s.sessions.map((x) => x.id)).toEqual(['b']);
	});

	it('renames in place when the id stays', () => {
		const s = applyEvents(base(), [ev(11, 'session-renamed', 'a', { title: 'Fix login', id: 'a' })]);
		expect(s.sessions.find((x) => x.id === 'a')?.title).toBe('Fix login');
	});

	it('moves a renamed terminal to its new id and url', () => {
		const start = applySnapshot([row('t:old', { kind: 'shell' })], 1);
		const s = applyEvents(start, [ev(2, 'session-renamed', 't:old', { title: 'new', id: 't:new' })]);
		expect(s.sessions).toEqual([
			{ ...row('t:new', { kind: 'shell' }), title: 'new', url: 'http://example.test/s/t:new' }
		]);
	});

	it('drops a duplicate already sitting at the rename target', () => {
		const start = applySnapshot([row('t:old'), row('t:new')], 1);
		const s = applyEvents(start, [ev(2, 'session-renamed', 't:old', { title: 'new', id: 't:new' })]);
		expect(s.sessions.map((x) => x.id)).toEqual(['t:new']);
		expect(s.sessions[0].title).toBe('new');
	});

	it('ignores a rename for a session it does not hold', () => {
		const s = applyEvents(base(), [ev(11, 'session-renamed', 'zz', { title: 'x', id: 'yy' })]);
		expect(s.sessions.map((x) => x.id)).toEqual(['b', 'a']);
	});

	it('sets and clears hidden', () => {
		let s = applyEvents(base(), [ev(11, 'session-hidden', 'a', { hidden: true })]);
		expect(s.sessions.find((x) => x.id === 'a')?.hidden).toBe(true);
		s = applyEvents(s, [ev(12, 'session-hidden', 'a', { hidden: false })]);
		expect('hidden' in s.sessions.find((x) => x.id === 'a')!).toBe(false);
	});

	it('takes the pr, and clears it on null', () => {
		const pr = { repo: 'acme/app', number: 4, url: 'https://github.com/acme/app/pull/4' };
		let s = applyEvents(base(), [ev(11, 'pr', 'a', { pr })]);
		expect(s.sessions.find((x) => x.id === 'a')?.pr).toEqual(pr);
		s = applyEvents(s, [ev(12, 'pr', 'a', { pr: null })]);
		expect(s.sessions.find((x) => x.id === 'a')?.pr).toBeUndefined();
	});

	it('takes the cost off turn-finished without the fold state', () => {
		const cost = { costUsd: 1.5, turns: 3, durationMs: 100, results: 3, lastReportedCost: 1.5 };
		const s = applyEvents(base(), [ev(11, 'turn-finished', 'a', { subtype: 'success', cost })]);
		expect(s.sessions.find((x) => x.id === 'a')?.cost).toEqual({ costUsd: 1.5, turns: 3, durationMs: 100, results: 3 });
	});

	it('advances the cursor past events that are not sessions', () => {
		const s = applyEvents(base(), [ev(11, 'run-updated', 'r1'), ev(12, 'pairing', 'p1')]);
		expect(s.sessions).toHaveLength(2);
		expect(s.seq).toBe(12);
	});

	it('takes the response seq when it is ahead of the events', () => {
		expect(applyEvents(base(), [], 15).seq).toBe(15);
	});
});

describe('applyResponse', () => {
	it('replaces everything on a gap', () => {
		const s = applyResponse(base(), { gap: true, snapshot: [row('z')], seq: 99 });
		expect(s.sessions.map((x) => x.id)).toEqual(['z']);
		expect(s.seq).toBe(99);
	});

	it('folds an events response', () => {
		const s = applyResponse(base(), { events: [ev(11, 'session-deleted', 'b')], seq: 11 });
		expect(s.sessions.map((x) => x.id)).toEqual(['a']);
	});
});

describe('cursorWentBack', () => {
	it('is true when the log seq falls below the cursor', () => {
		expect(cursorWentBack(base(), { events: [], seq: 3 })).toBe(true);
		expect(cursorWentBack(base(), { events: [], seq: 10 })).toBe(false);
		expect(cursorWentBack(base(), { snapshot: [], seq: 3 })).toBe(false);
		expect(cursorWentBack(null, { events: [], seq: 3 })).toBe(false);
	});
});

describe('feedUrl', () => {
	it('bootstraps without a cursor, then long-polls past it', () => {
		expect(feedUrl(null)).toBe('/api/agent/events');
		expect(feedUrl(base())).toBe('/api/agent/events?since=10&wait=1');
	});
});

describe('backoffMs', () => {
	it('doubles from 1s and caps at 30s', () => {
		expect([1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
	});
});

describe('readFeed', () => {
	const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

	it('returns the response of a live read', async () => {
		const body = await readFeed(async () => ok({ events: [], seq: 4 }), null, new AbortController().signal);
		expect(body).toEqual({ events: [], seq: 4 });
	});

	it('drops a response that lands after the read was aborted', async () => {
		const ctrl = new AbortController();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const pending = readFeed(
			async () => {
				await gate;
				return ok({ snapshot: [row('stale')], seq: 1 });
			},
			base(),
			ctrl.signal
		);
		ctrl.abort();
		release();
		expect(await pending).toBeNull();
	});

	it('throws on a failed read', async () => {
		await expect(
			readFeed(async () => new Response('', { status: 500 }), null, new AbortController().signal)
		).rejects.toThrow('feed 500');
	});
});
