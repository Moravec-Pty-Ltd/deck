import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';
import { DEFAULT_COMPACT_PERCENT } from '$lib/context-core';

const sessions: Record<string, DeckSession> = {
	c_full: { id: 'c_full', kind: 'claude', title: 'Full', cwd: '/p', status: 'idle', createdAt: 1, lastActiveAt: 2 } as DeckSession,
	s_shell: { id: 's_shell', kind: 'shell', title: 'Shell', cwd: '/p', status: 'idle', createdAt: 1, lastActiveAt: 2 } as DeckSession
};

let settings: Record<string, unknown> = {};
let context = { used: 0, window: 1_000_000 };
const sent = vi.fn(async (_session: DeckSession, _body: Record<string, unknown>) => {});

vi.mock('./store', () => ({
	setSessionsMutatedHook: () => {},
	readSettings: () => settings,
	getStoredSession: (id: string) => sessions[id]
}));
vi.mock('./transcript', () => ({ transcriptContext: () => context }));
vi.mock('./send-agent-message', () => ({
	sendAgentMessage: (session: DeckSession, body: Record<string, unknown>) => sent(session, body)
}));

const { compactPolicy, compactSession, compactInFlight, maybeAutoCompact } = await import('./auto-compact');

// The module keeps in-flight state on globalThis so a dev reload can't fire a
// second compaction; clear it between tests.
function resetInFlight() {
	(globalThis as { __deckCompacting?: Set<string> }).__deckCompacting?.clear();
}

// maybeAutoCompact sends without awaiting, so let the microtask queue drain.
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	settings = { autoCompact: { enabled: true, percent: 80 } };
	context = { used: 0, window: 1_000_000 };
	vi.clearAllMocks();
	resetInFlight();
});

describe('compactPolicy', () => {
	it('is off unless explicitly enabled', () => {
		settings = {};
		expect(compactPolicy()).toEqual({ enabled: false, percent: DEFAULT_COMPACT_PERCENT });
		settings = { autoCompact: { percent: 70 } };
		expect(compactPolicy()).toEqual({ enabled: false, percent: 70 });
		settings = { autoCompact: { enabled: 'yes' } };
		expect(compactPolicy().enabled).toBe(false);
	});

	it('holds a silly threshold to the usable range', () => {
		settings = { autoCompact: { enabled: true, percent: 5 } };
		expect(compactPolicy().percent).toBe(50);
		settings = { autoCompact: { enabled: true, percent: 200 } };
		expect(compactPolicy().percent).toBe(95);
	});
});

describe('maybeAutoCompact', () => {
	it('sends a compaction once the window passes the threshold', async () => {
		context = { used: 800_000, window: 1_000_000 };
		maybeAutoCompact('c_full');
		await settle();
		expect(sent).toHaveBeenCalledTimes(1);
		const [session, body] = sent.mock.calls[0] as unknown as [DeckSession, { text: string }];
		expect(session.id).toBe('c_full');
		expect(body.text.startsWith('/compact ')).toBe(true);
	});

	it('leaves a session below the threshold alone', async () => {
		context = { used: 700_000, window: 1_000_000 };
		maybeAutoCompact('c_full');
		await settle();
		expect(sent).not.toHaveBeenCalled();
	});

	it('does nothing when the setting is off, however full the window', async () => {
		settings = { autoCompact: { enabled: false, percent: 80 } };
		context = { used: 999_000, window: 1_000_000 };
		maybeAutoCompact('c_full');
		await settle();
		expect(sent).not.toHaveBeenCalled();
	});

	it('only compacts claude sessions, and only ones it knows', async () => {
		context = { used: 999_000, window: 1_000_000 };
		maybeAutoCompact('s_shell');
		maybeAutoCompact('c_gone');
		await settle();
		expect(sent).not.toHaveBeenCalled();
	});

	it('waits before any window has been reported', async () => {
		context = { used: 900_000, window: 0 };
		maybeAutoCompact('c_full');
		await settle();
		expect(sent).not.toHaveBeenCalled();
	});

	// The compaction is itself a turn, and the result that ends it still reports
	// the pre-compaction usage. Firing again on that would compact forever.
	it('does not fire again on the compaction turn it just started', async () => {
		context = { used: 800_000, window: 1_000_000 };
		maybeAutoCompact('c_full');
		await settle();
		expect(sent).toHaveBeenCalledTimes(1);

		maybeAutoCompact('c_full'); // the compaction's own result
		await settle();
		expect(sent).toHaveBeenCalledTimes(1);
		expect(compactInFlight('c_full')).toBe(true);
	});

	it('arms again once the context has actually come down', async () => {
		context = { used: 800_000, window: 1_000_000 };
		maybeAutoCompact('c_full');
		await settle();

		context = { used: 13_000, window: 1_000_000 }; // the compaction landed
		maybeAutoCompact('c_full');
		await settle();
		expect(compactInFlight('c_full')).toBe(false);
		expect(sent).toHaveBeenCalledTimes(1);

		context = { used: 810_000, window: 1_000_000 }; // it filled up again
		maybeAutoCompact('c_full');
		await settle();
		expect(sent).toHaveBeenCalledTimes(2);
	});

	it('swallows a send failure and lets the next turn try again', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		sent.mockRejectedValueOnce(new Error('session is busy'));
		context = { used: 800_000, window: 1_000_000 };
		expect(() => maybeAutoCompact('c_full')).not.toThrow();
		await settle();
		expect(compactInFlight('c_full')).toBe(false);

		maybeAutoCompact('c_full');
		await settle();
		expect(sent).toHaveBeenCalledTimes(2);
		error.mockRestore();
	});
});

// The trigger is a subscription (importing the module wires it), not a call
// from claude.ts: this module sends messages, which reaches claude.ts, so a
// call the other way would be an import cycle.
describe('the turn-finished subscription', () => {
	it('compacts when a finished turn leaves the window over the threshold', async () => {
		const { agentFeed } = await import('./agent-feed');
		context = { used: 850_000, window: 1_000_000 };
		agentFeed.emit('event', { seq: 1, sessionId: 'c_full', type: 'turn-finished', at: Date.now() });
		await settle();
		expect(sent).toHaveBeenCalledTimes(1);
	});

	it('ignores every other kind of feed event', async () => {
		const { agentFeed } = await import('./agent-feed');
		context = { used: 999_000, window: 1_000_000 };
		for (const type of ['status', 'awaiting-input', 'pr', 'session-created', 'session-renamed']) {
			agentFeed.emit('event', { seq: 1, sessionId: 'c_full', type, at: Date.now() });
		}
		await settle();
		expect(sent).not.toHaveBeenCalled();
	});
});

describe('compactSession', () => {
	it('sends the command whatever the setting says, since you asked for it', async () => {
		settings = { autoCompact: { enabled: false } };
		await compactSession(sessions.c_full);
		expect(sent).toHaveBeenCalledTimes(1);
		expect(compactInFlight('c_full')).toBe(true);
	});
});
