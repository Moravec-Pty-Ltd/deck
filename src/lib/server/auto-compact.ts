import type { DeckSession } from '$lib/types';
import { clampCompactPercent, compactCommand, overCompactThreshold } from '$lib/context-core';
import { readSettings, getStoredSession } from './store';
import { transcriptContext } from './transcript';
import { sendAgentMessage } from './send-agent-message';
import { agentFeed, type AgentFeedEvent } from './agent-feed';

// Compact a claude session before its context window fills, instead of leaving
// it to claude's own auto-compaction. Measured across this machine's
// transcripts, that only fires at 999k to 1003k of a 1M window and takes 50 to
// 75 seconds, all of it landing on the end of a turn you were waiting on.
// Compacting at a threshold you pick moves that cost somewhere you chose.
//
// Driven off the agent feed's `turn-finished` (a finished turn is where the
// context is at its fullest), the way live-activity.ts and the operator listen.
// Subscribing rather than being called from claude.ts also keeps the imports
// one-directional: this module sends messages, which reaches claude.ts, so a
// call the other way would be a cycle. hooks.server.ts imports this module for
// the subscription below.

// One in-flight compaction per session. A compaction is itself a turn, so its
// own `result` re-enters this hook, and the usage it reports has not dropped
// yet (the assistant message carrying the smaller figure comes after). Without
// this the session would compact on every turn from here on. Cleared once the
// context has actually come down. Kept on globalThis so a dev reload doesn't
// forget what is already running and fire a second one.
const g = globalThis as { __deckCompacting?: Set<string> };
const compacting = (g.__deckCompacting ??= new Set<string>());

export function compactInFlight(id: string): boolean {
	return compacting.has(id);
}

interface CompactPolicy {
	enabled: boolean;
	percent: number;
}

export function compactPolicy(): CompactPolicy {
	const configured = readSettings().autoCompact;
	return {
		enabled: configured?.enabled === true,
		percent: clampCompactPercent(configured?.percent)
	};
}

// Send the compaction. Exported so the browser's "Compact now" button and the
// automatic trigger run exactly the same thing.
export async function compactSession(session: DeckSession): Promise<void> {
	compacting.add(session.id);
	try {
		await sendAgentMessage(session, { text: compactCommand() });
	} catch (err) {
		// Let the next turn try again rather than wedging the session shut.
		compacting.delete(session.id);
		throw err;
	}
}

// Called on every finished turn. Never throws into the append path: a failed
// compaction must not take the transcript write with it.
export function maybeAutoCompact(id: string): void {
	const session = getStoredSession(id);
	if (!session || session.kind !== 'claude') return;

	const context = transcriptContext(id);
	const policy = compactPolicy();
	if (compacting.has(id)) {
		// The compaction landed: its own turn brought the context back under the
		// threshold, so the session is free to fill up and compact again later.
		if (!overCompactThreshold(context, policy.percent)) compacting.delete(id);
		return;
	}
	if (!policy.enabled) return;
	if (!overCompactThreshold(context, policy.percent)) return;

	void compactSession(session).catch((err) => {
		console.error(`[deck] auto-compact failed for ${id}:`, err);
	});
}

// Survives HMR in dev: one subscription, swapping the handler, so a reload
// neither doubles the listener nor leaves it on stale code.
const wiring = globalThis as { __deckAutoCompactWired?: boolean };
if (!wiring.__deckAutoCompactWired) {
	wiring.__deckAutoCompactWired = true;
	agentFeed.on('event', (event: AgentFeedEvent) => {
		if (event.type === 'turn-finished') maybeAutoCompact(event.sessionId);
	});
}
