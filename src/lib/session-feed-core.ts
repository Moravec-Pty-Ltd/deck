import type { CostSummary } from '$lib/session-cost-core';
import { publicCost, type SessionView } from '$lib/session-view';
import type { SessionPR, SessionStatus } from '$lib/types';
import type { Watch } from '$lib/watches';

// The web session list, kept from the agent event log (GET /api/agent/events)
// instead of re-fetching every session on a timer. A bootstrap (or a gap) hands
// over a whole snapshot; after that each long-poll brings only the events past
// the cursor, which are folded into the list here. Node-free so the fold tests
// without a server; the loop that fetches lives in session-feed.svelte.ts.

export interface FeedEvent {
	seq: number;
	sessionId: string;
	type: string;
	at: number;
	[key: string]: unknown;
}

export type FeedResponse =
	| { snapshot: SessionView[]; seq: number; gap?: boolean }
	| { events: FeedEvent[]; seq: number };

export interface FeedState {
	sessions: SessionView[];
	// The last seq folded in: the next long-poll asks for what came after it.
	seq: number;
}

const STATUSES: ReadonlySet<string> = new Set(['running', 'idle', 'error', 'dead']);

function isCost(v: unknown): v is CostSummary {
	return !!v && typeof v === 'object' && typeof (v as CostSummary).costUsd === 'number';
}

// Field updates, one per event type that changes a session in place. Each is
// idempotent, so an event the snapshot already reflects can land again safely.
const PATCHES: Record<string, (s: SessionView, e: FeedEvent) => SessionView> = {
	status: (s, e) =>
		typeof e.status === 'string' && STATUSES.has(e.status)
			? { ...s, status: e.status as SessionStatus, lastActiveAt: Math.max(s.lastActiveAt, e.at) }
			: s,
	'awaiting-input': (s, e) => ({ ...s, awaitingInput: !!e.awaitingInput }),
	'turn-finished': (s, e) => (isCost(e.cost) ? { ...s, cost: publicCost(e.cost) } : s),
	pr: (s, e) => ({ ...s, pr: (e.pr as SessionPR | null) ?? undefined }),
	watches: (s, e) => {
		const next = { ...s };
		if (Array.isArray(e.watches) && e.watches.length) next.watches = e.watches as Watch[];
		else delete next.watches;
		return next;
	},
	'session-hidden': (s, e) => {
		const next = { ...s };
		if (e.hidden) next.hidden = true;
		else delete next.hidden;
		return next;
	}
};

function patch(sessions: SessionView[], e: FeedEvent): SessionView[] {
	const apply = PATCHES[e.type];
	return sessions.map((s) => (s.id === e.sessionId ? apply(s, e) : s));
}

function upsert(sessions: SessionView[], row: SessionView): SessionView[] {
	return [row, ...sessions.filter((s) => s.id !== row.id)];
}

function withId(s: SessionView, id: string): SessionView {
	const at = s.url.lastIndexOf('/s/');
	return { ...s, id, url: at >= 0 ? `${s.url.slice(0, at)}/s/${id}` : s.url };
}

// A renamed tmux terminal moves to a new id (the event's `id`); anything else
// keeps its id and only takes the title. A row already sitting at the target id
// is the same session arriving through a snapshot, so it gives way.
function rename(sessions: SessionView[], e: FeedEvent): SessionView[] {
	const row = sessions.find((s) => s.id === e.sessionId);
	if (!row) return sessions;
	const to = typeof e.id === 'string' && e.id ? e.id : row.id;
	const title = typeof e.title === 'string' ? e.title : row.title;
	const moved = withId({ ...row, title }, to);
	return sessions.flatMap((s) => {
		if (s.id === row.id) return [moved];
		return s.id === to ? [] : [s];
	});
}

function isRow(v: unknown): v is SessionView {
	return !!v && typeof v === 'object' && typeof (v as SessionView).id === 'string';
}

function applyEvent(sessions: SessionView[], e: FeedEvent): SessionView[] {
	if (e.type === 'session-created') return isRow(e.session) ? upsert(sessions, e.session) : sessions;
	if (e.type === 'session-deleted') return sessions.filter((s) => s.id !== e.sessionId);
	if (e.type === 'session-renamed') return rename(sessions, e);
	// run-updated, run-deleted, pairing and anything newer ride the same cursor but
	// are not sessions.
	return e.type in PATCHES ? patch(sessions, e) : sessions;
}

// Newest activity first, the order the server lists in.
function ordered(sessions: SessionView[]): SessionView[] {
	return [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function applySnapshot(snapshot: SessionView[], seq: number): FeedState {
	return { sessions: ordered(snapshot), seq };
}

// Fold events past the cursor in seq order. Whatever is at or below it has been
// applied already (a repeat, or an overlap with the snapshot), so it is skipped.
export function applyEvents(state: FeedState, events: FeedEvent[], seq = state.seq): FeedState {
	const fresh = events.filter((e) => e.seq > state.seq).sort((a, b) => a.seq - b.seq);
	const last = fresh.length ? fresh[fresh.length - 1].seq : state.seq;
	const next = Math.max(state.seq, seq, last);
	if (!fresh.length) return next === state.seq ? state : { ...state, seq: next };
	return { sessions: ordered(fresh.reduce(applyEvent, state.sessions)), seq: next };
}

export function applyResponse(state: FeedState | null, res: FeedResponse): FeedState {
	if ('snapshot' in res) return applySnapshot(res.snapshot, res.seq);
	return applyEvents(state ?? applySnapshot([], 0), res.events, res.seq);
}

// The log's seq fell below our cursor: it was reset under us (a wiped data
// dir), so no event we wait for will ever arrive. Only a fresh snapshot recovers.
export function cursorWentBack(state: FeedState | null, res: FeedResponse): boolean {
	return !!state && !('snapshot' in res) && res.seq < state.seq;
}

// Where the next request goes: a bootstrap until there is a cursor, then the
// long-poll past it.
export function feedUrl(state: FeedState | null): string {
	return state ? `/api/agent/events?since=${state.seq}&wait=1` : '/api/agent/events';
}

// Retry delay after consecutive failures: 1s, 2s, 4s ... capped at 30s.
export function backoffMs(failures: number): number {
	return Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
}

// One feed request. Resolves to null once the signal is aborted, even when the
// response itself still arrives (a fetch that ignores the signal, or a body that
// lands after the abort): an aborted read was asked for under a stale cursor.
export async function readFeed(
	fetcher: (url: string, init: { signal: AbortSignal }) => Promise<Response>,
	state: FeedState | null,
	signal: AbortSignal
): Promise<FeedResponse | null> {
	const res = await fetcher(feedUrl(state), { signal });
	if (signal.aborted) return null;
	if (!res.ok) throw new Error(`feed ${res.status}`);
	const body = (await res.json()) as FeedResponse;
	return signal.aborted ? null : body;
}
