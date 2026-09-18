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
		push: vi.fn()
	};
});
vi.mock('./agent-feed', () => ({ agentFeed: mocks.feed }));
vi.mock('./claude', () => ({ bus: mocks.bus }));
vi.mock('./store', () => ({ getStoredSession: mocks.session }));
vi.mock('./transcript', () => ({ sessionLastResult: mocks.lastResult, transcriptCostSummary: mocks.cost }));
vi.mock('./apns', () => ({ activitiesFor: mocks.activities, apnsActivity: mocks.push }));
await import('./live-activity');

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockReturnValue({ id: 's', status: 'running', awaitingInput: false });
	mocks.lastResult.mockReturnValue('Working on the middleware now.');
	mocks.cost.mockReturnValue({ costUsd: 0.12345, turns: 3, durationMs: 0, results: 3 });
	mocks.activities.mockReturnValue([{ sessionId: 's', token: 't', env: 'production', addedAt: 0 }]);
	mocks.push.mockResolvedValue(undefined);
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
