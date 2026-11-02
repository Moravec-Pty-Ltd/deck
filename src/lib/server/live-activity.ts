import { agentFeed, type AgentFeedEvent } from './agent-feed';
import { bus } from './claude';
import { getStoredSession } from './store';
import { sessionLastResult, transcriptCostSummary } from './transcript';
import { subagentCount } from './subagent-count';
import { isWorking } from '$lib/status-groups';
import type { DeckSession } from '$lib/types';
import { activitiesFor, apnsActivity, apnsActivityStart } from './apns';
import {
	ACTIVITY_START_DELAY_MS,
	ACTIVITY_START_GAP_MS,
	activityDismissAt,
	activityText,
	keepsActivity,
	shouldPushText,
	startsActivity,
	toActivityPush,
	toActivityStartPush,
	type ActivityState
} from './apns-core';

// Keeps a session's Live Activity (the lock-screen card the phone starts) in
// step with the session: status changes and question asks push immediately,
// mid-turn assistant text at a throttled cadence. A session going quiet ends
// its card, which leaves the lock screen once the just-finished window passes;
// a new turn or question starts one by push when the phone has none.
// Subscribes to the same feeds the clients read, so it needs no hooks in the
// producers.

const textPushedAt = new Map<string, number>();
const startPushedAt = new Map<string, number>();
const startPending = new Set<string>();

const viewOf = (session: DeckSession) => ({ ...session, subagents: subagentCount(session.id) });

// The card's content from what deck already tracks: the stored session, the
// cost fold, and the newest assistant text on the transcript tail.
function activityStateFor(sessionId: string): ActivityState | null {
	const session = getStoredSession(sessionId);
	if (!session) return null;
	const cost = transcriptCostSummary(sessionId);
	return {
		// Subagents still going read as running, as on every other surface.
		status: isWorking(viewOf(session)) ? 'running' : session.status,
		awaitingInput: !!session.awaitingInput,
		lastText: activityText(sessionLastResult(sessionId)),
		costUsd: Math.round(cost.costUsd * 10000) / 10000,
		turns: cost.turns,
		updatedAt: Date.now()
	};
}

async function pushUpdate(sessionId: string): Promise<void> {
	const state = activityStateFor(sessionId);
	if (!state) return;
	await apnsActivity(sessionId, toActivityPush(state, 'update', Date.now()));
}

// Keep, end or start the session's card by the shared rule. `update: false`
// pushes only an end, for events the card doesn't show.
export async function syncCard(sessionId: string, update = true): Promise<void> {
	const session = getStoredSession(sessionId);
	if (!session) return;
	if (activitiesFor(sessionId).length) await keepOrEnd(session, update);
	else if (startsActivity(viewOf(session))) await pushStart(sessionId);
}

async function keepOrEnd(session: DeckSession, update: boolean): Promise<void> {
	startPushedAt.delete(session.id);
	const ends = !keepsActivity(viewOf(session));
	if (!ends && !update) return;
	const state = activityStateFor(session.id);
	if (!state) return;
	const dismissAt = ends ? activityDismissAt(session.lastActiveAt) : undefined;
	await apnsActivity(session.id, toActivityPush(state, ends ? 'end' : 'update', Date.now(), dismissAt));
}

// Waits first, then starts only if the session still has no card and still
// qualifies; the gap is armed only once a start is sent.
async function pushStart(sessionId: string): Promise<void> {
	const last = startPushedAt.get(sessionId);
	if (startPending.has(sessionId) || (last !== undefined && Date.now() - last < ACTIVITY_START_GAP_MS)) return;
	startPending.add(sessionId);
	try {
		await new Promise((r) => setTimeout(r, ACTIVITY_START_DELAY_MS));
		const later = getStoredSession(sessionId);
		if (!later || activitiesFor(sessionId).length || !startsActivity(viewOf(later))) return;
		const state = activityStateFor(sessionId);
		if (!state) return;
		const now = Date.now();
		startPushedAt.set(sessionId, now);
		await apnsActivityStart(toActivityStartPush(later, state, now));
	} finally {
		startPending.delete(sessionId);
	}
}

function onFeedEvent(event: AgentFeedEvent): void {
	switch (event.type) {
		case 'status':
		case 'awaiting-input':
		case 'turn-finished':
			void syncCard(event.sessionId);
			break;
		case 'session-unread':
		case 'subagents':
			void syncCard(event.sessionId, false);
			break;
		case 'session-deleted':
			startPushedAt.delete(event.sessionId);
			if (!activitiesFor(event.sessionId).length) return;
			void apnsActivity(event.sessionId, toActivityPush(
				{ status: 'dead', awaitingInput: false, lastText: '', costUsd: 0, turns: 0, updatedAt: Date.now() },
				'end',
				Date.now()
			));
			break;
	}
}

// Assistant text lands on the per-session transcript bus; refresh the card's
// text at most every few seconds so a chatty turn doesn't burn the push budget.
function onTranscriptEvent(sessionId: string, event: { type?: string; message?: { content?: unknown } }): void {
	if (event.type !== 'assistant') return;
	const content = event.message?.content;
	const hasText = Array.isArray(content) && content.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
	if (!hasText || !activitiesFor(sessionId).length) return;
	const now = Date.now();
	if (!shouldPushText(textPushedAt.get(sessionId), now)) return;
	textPushedAt.set(sessionId, now);
	void pushUpdate(sessionId);
}

const g = globalThis as { __deckLiveActivityWired?: boolean };
if (!g.__deckLiveActivityWired) {
	g.__deckLiveActivityWired = true;
	agentFeed.on('event', (event: AgentFeedEvent) => {
		try {
			onFeedEvent(event);
		} catch (err) {
			console.error('[deck] live activity feed handler failed:', err);
		}
	});
	bus.on('event', ({ id, event }: { id: string; event: { type?: string } }) => {
		try {
			onTranscriptEvent(id, event);
		} catch (err) {
			console.error('[deck] live activity transcript handler failed:', err);
		}
	});
}
