import type { DeckSession } from '$lib/types';
import * as claude from '../claude';
import type { ImageInput, SendMeta } from '../claude';
import * as runner from './runner';
import { getStoredSession } from '../store';
import { stopOutcome, type StopOutcome } from './stop-core';

// The send in flight per session; a Stop during start-up clears it early.
const sending = new Map<string, object>();

// Unified agent control across the persistent Claude engine and the per-turn
// runner (pi/codex). Process registries are keyed by session id and disjoint, so
// the combined helpers can address either without knowing the kind.

export function agentTurnRunning(id: string): boolean {
	return sending.has(id) || claude.isTurnRunning(id) || runner.turnRunning(id);
}

// Stop the turn; `force` ends a claude process that ignores the interrupt. A
// session left marked running with no live turn goes idle.
export function agentInterrupt(id: string, force = false): StopOutcome {
	const session = getStoredSession(id);
	let live: boolean;
	if (session?.kind === 'claude') {
		live = force ? claude.forceStop(id) : claude.interrupt(id);
	} else {
		live = force ? runner.forceStopTurn(id) : runner.interruptTurn(id);
	}
	// A send still waiting on its start no longer holds the turn open.
	sending.delete(id);
	const outcome = stopOutcome(live, session?.status === 'running');
	if (outcome === 'not-tracked') claude.setStatus(id, 'idle');
	return outcome;
}

export function agentStop(id: string) {
	claude.stopProcess(id);
	runner.interruptTurn(id);
}

export async function agentSend(
	session: DeckSession,
	text: string,
	images?: ImageInput[],
	meta?: SendMeta
) {
	const token = {};
	sending.set(session.id, token);
	try {
		if (session.kind === 'claude') {
			await claude.sendMessage(session.id, text, images, meta);
			return;
		}
		await runner.runTurn(session, text, meta?.voice === true);
	} finally {
		if (sending.get(session.id) === token) sending.delete(session.id);
	}
}
