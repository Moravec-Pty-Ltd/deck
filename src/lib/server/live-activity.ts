import { agentFeed, type AgentFeedEvent } from './agent-feed';
import { bus } from './claude';
import { getStoredSession } from './store';
import { sessionLastResult, transcriptCostSummary } from './transcript';
import { activitiesFor, apnsActivity } from './apns';
import { activityText, shouldPushText, toActivityPush, type ActivityState } from './apns-core';

// Keeps a session's Live Activity (the lock-screen card the phone starts) in
// step with the session: status changes and question asks push immediately,
// mid-turn assistant text at a throttled cadence, and deletion ends the card.
// Subscribes to the same feeds the clients read, so it needs no hooks in the
// producers.

const textPushedAt = new Map<string, number>();

// The card's content from what deck already tracks: the stored session, the
// cost fold, and the newest assistant text on the transcript tail.
function activityStateFor(sessionId: string): ActivityState | null {
	const session = getStoredSession(sessionId);
	if (!session) return null;
	const cost = transcriptCostSummary(sessionId);
	return {
		status: session.status,
		awaitingInput: !!session.awaitingInput,
		lastText: activityText(sessionLastResult(sessionId)),
		costUsd: Math.round(cost.costUsd * 10000) / 10000,
		turns: cost.turns,
		updatedAt: Date.now()
	};
}

async function pushState(sessionId: string, event: 'update' | 'end'): Promise<void> {
	const state = activityStateFor(sessionId);
	if (!state) return;
	await apnsActivity(sessionId, toActivityPush(state, event, Date.now()));
}

function onFeedEvent(event: AgentFeedEvent): void {
	if (!activitiesFor(event.sessionId).length) return;
	switch (event.type) {
		case 'status':
		case 'awaiting-input':
		case 'turn-finished':
			void pushState(event.sessionId, 'update');
			break;
		case 'session-deleted':
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
	void pushState(sessionId, 'update');
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
