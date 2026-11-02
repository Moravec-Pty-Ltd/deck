import { beforeEach, expect, it, vi } from 'vitest';

// A minimal emitter, defined inside the hoisted block since module imports
// are not available there yet.
const mocks = vi.hoisted(() => {
	class Emitter {
		private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
		on(name: string, fn: (...args: unknown[]) => void) {
			this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
			return this;
		}
		emit(name: string, ...args: unknown[]) {
			for (const fn of this.listeners.get(name) ?? []) fn(...args);
			return true;
		}
	}
	return {
		feed: new Emitter(),
		bus: new Emitter(),
		session: vi.fn(),
		lastResult: vi.fn(),
		cost: vi.fn(),
		activities: vi.fn(),
		push: vi.fn(),
		start: vi.fn(),
		subagents: vi.fn()
	};
});
vi.mock('./agent-feed', () => ({ agentFeed: mocks.feed }));
vi.mock('./claude', () => ({ bus: mocks.bus }));
vi.mock('./store', () => ({ getStoredSession: mocks.session }));
vi.mock('./transcript', () => ({ sessionLastResult: mocks.lastResult, transcriptCostSummary: mocks.cost }));
vi.mock('./apns', () => ({ activitiesFor: mocks.activities, apnsActivity: mocks.push, apnsActivityStart: mocks.start }));
vi.mock('./subagent-count', () => ({ subagentCount: mocks.subagents }));
const { syncCard } = await import('./live-activity');

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockReturnValue({ id: 's', title: 'Fix login', status: 'running', awaitingInput: false, lastActiveAt: 1_000_000 });
	mocks.subagents.mockReturnValue(0);
	mocks.lastResult.mockReturnValue('Working on the middleware now.');
	mocks.cost.mockReturnValue({ costUsd: 0.12345, turns: 3, durationMs: 0, results: 3 });
	mocks.activities.mockReturnValue([{ sessionId: 's', token: 't', env: 'production', addedAt: 0 }]);
	mocks.push.mockResolvedValue(undefined);
	mocks.start.mockResolvedValue(undefined);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

it('pushes the session state on status changes', async () => {
	mocks.feed.emit('event', { seq: 1, sessionId: 's', type: 'status', at: 0, status: 'running' });
	await flush();
	expect(mocks.push).toHaveBeenCalledWith('s', expect.objectContaining({
		aps: expect.objectContaining({ event: 'update', 'content-state': expect.objectContaining({ status: 'running', lastText: 'Working on the middleware now.', costUsd: 0.1235, turns: 3 }) })
	}));
});

it('ends the activity when the session is deleted and ignores sessions without one', async () => {
	mocks.feed.emit('event', { seq: 2, sessionId: 's', type: 'session-deleted', at: 0 });
	await flush();
	expect(mocks.push).toHaveBeenCalledWith('s', expect.objectContaining({ aps: expect.objectContaining({ event: 'end' }) }));
	mocks.push.mockClear();
	mocks.activities.mockReturnValue([]);
	mocks.feed.emit('event', { seq: 3, sessionId: 's', type: 'status', at: 0, status: 'idle' });
	await flush();
	expect(mocks.push).not.toHaveBeenCalled();
});

it('throttles text updates from the transcript bus', async () => {
	const text = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
	mocks.bus.emit('event', { id: 's', event: text });
	mocks.bus.emit('event', { id: 's', event: text });
	mocks.bus.emit('event', { id: 's', event: { type: 'assistant', message: { content: [{ type: 'tool_use' }] } } });
	await flush();
	expect(mocks.push).toHaveBeenCalledTimes(1);
});

it('ends the card of a quiet session at the end of the just-finished window', async () => {
	mocks.session.mockReturnValue({ id: 's', title: 'Fix login', status: 'idle', lastActiveAt: 1_000_000 });
	mocks.feed.emit('event', { seq: 4, sessionId: 's', type: 'turn-finished', at: 0 });
	await flush();
	expect(mocks.push).toHaveBeenCalledWith('s', expect.objectContaining({
		aps: expect.objectContaining({ event: 'end', 'dismissal-date': 1000 + 15 * 60 })
	}));
});

it('keeps the card while subagents work, a question waits, or an error is unread', async () => {
	const keep = [
		{ status: 'idle', lastActiveAt: 0, subagents: 1 },
		{ status: 'idle', lastActiveAt: 0, awaitingInput: true },
		{ status: 'error', lastActiveAt: 0, unread: true }
	];
	for (const { subagents = 0, ...session } of keep) {
		mocks.push.mockClear();
		mocks.session.mockReturnValue({ id: 's', title: 't', ...session });
		mocks.subagents.mockReturnValue(subagents);
		mocks.feed.emit('event', { seq: 5, sessionId: 's', type: 'status', at: 0 });
		await flush();
		expect(mocks.push).toHaveBeenCalledWith('s', expect.objectContaining({ aps: expect.objectContaining({ event: 'update' }) }));
	}
});

it('starts a card by push when a session with none starts working, once per gap', async () => {
	vi.useFakeTimers();
	try {
		mocks.activities.mockReturnValue([]);
		mocks.session.mockReturnValue({ id: 'n', title: 'Fix login', status: 'running', lastActiveAt: 0 });
		mocks.feed.emit('event', { seq: 6, sessionId: 'n', type: 'status', at: 0 });
		mocks.feed.emit('event', { seq: 7, sessionId: 'n', type: 'awaiting-input', at: 0 });
		await vi.advanceTimersByTimeAsync(9_000);
		expect(mocks.start).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
			aps: expect.objectContaining({ event: 'start', attributes: expect.objectContaining({ sessionId: 'n', title: 'Fix login' }) })
		}));
		expect(mocks.push).not.toHaveBeenCalled();
		mocks.feed.emit('event', { seq: 14, sessionId: 'n', type: 'awaiting-input', at: 0 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.start).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		mocks.feed.emit('event', { seq: 15, sessionId: 'n', type: 'status', at: 0 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.start).toHaveBeenCalledTimes(2);
		mocks.session.mockReturnValue({ id: 'q', title: 't', status: 'idle', lastActiveAt: 0 });
		mocks.feed.emit('event', { seq: 8, sessionId: 'q', type: 'turn-finished', at: 0 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.start).toHaveBeenCalledTimes(2);
	} finally {
		vi.useRealTimers();
	}
});

it('skips the push start when the app registered its own card, or the turn ended, first', async () => {
	vi.useFakeTimers();
	try {
		mocks.activities.mockReturnValue([]);
		mocks.session.mockReturnValue({ id: 'a', title: 't', status: 'running', lastActiveAt: 0 });
		mocks.feed.emit('event', { seq: 9, sessionId: 'a', type: 'status', at: 0 });
		mocks.activities.mockReturnValue([{ sessionId: 'a', token: 't', env: 'production', addedAt: 0 }]);
		await vi.advanceTimersByTimeAsync(10_000);
		mocks.activities.mockReturnValue([]);
		mocks.feed.emit('event', { seq: 10, sessionId: 'b', type: 'status', at: 0 });
		mocks.session.mockReturnValue({ id: 'b', title: 't', status: 'idle', lastActiveAt: 0 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.start).not.toHaveBeenCalled();
		// The aborted start doesn't hold the next turn off.
		mocks.session.mockReturnValue({ id: 'b', title: 't', status: 'running', lastActiveAt: 0 });
		mocks.feed.emit('event', { seq: 11, sessionId: 'b', type: 'status', at: 0 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.start).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it('shows subagents still working as running, and pushes nothing for a count change alone', async () => {
	mocks.session.mockReturnValue({ id: 's', title: 't', status: 'idle', lastActiveAt: 0 });
	mocks.subagents.mockReturnValue(2);
	mocks.feed.emit('event', { seq: 12, sessionId: 's', type: 'turn-finished', at: 0 });
	mocks.feed.emit('event', { seq: 13, sessionId: 's', type: 'subagents', at: 0 });
	await flush();
	expect(mocks.push).toHaveBeenCalledTimes(1);
	expect(mocks.push).toHaveBeenCalledWith('s', expect.objectContaining({
		aps: expect.objectContaining({ event: 'update', 'content-state': expect.objectContaining({ status: 'running' }) })
	}));
});

it('ends a card whose token arrives after the session went quiet', async () => {
	mocks.session.mockReturnValue({ id: 's', title: 't', status: 'idle', lastActiveAt: 1_000_000 });
	await syncCard('s');
	expect(mocks.push).toHaveBeenCalledWith('s', expect.objectContaining({
		aps: expect.objectContaining({ event: 'end', 'dismissal-date': 1000 + 15 * 60 })
	}));
});
