import type { DeckSession } from '$lib/types';
import * as claude from '../claude';
import type { ImageInput, SendMeta } from '../claude';
import * as runner from './runner';

const sending = new Set<string>();

// Unified agent control across the persistent Claude engine and the per-turn
// runner (pi/codex). Process registries are keyed by session id and disjoint, so
// the combined helpers can address either without knowing the kind.

export function agentTurnRunning(id: string): boolean {
	return sending.has(id) || claude.isTurnRunning(id) || runner.turnRunning(id);
}

export function agentInterrupt(id: string) {
	claude.interrupt(id);
	runner.interruptTurn(id);
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
	sending.add(session.id);
	try {
		if (session.kind === 'claude') {
			await claude.sendMessage(session.id, text, images, meta);
			return;
		}
		await runner.runTurn(session, text);
	} finally {
		sending.delete(session.id);
	}
}
