import { json, error } from '@sveltejs/kit';
import type { DeckEffort, DeckSession } from '$lib/types';
import { getStoredSession, updateSession } from './store';
import { agentTurnRunning } from './agents/dispatch';
import { appendEvent, stopProcess } from './claude';
import { objectBody } from './http';
import { parseEffort } from './session-effort-core';

// Change a session's reasoning effort mid-session (issue #178), mirroring
// session-model.ts. Idle-only: a running turn is a 409, never an interrupt.
// claude-only (the --effort flag has no equivalent on the other kinds). Shared
// verbatim by /api/sessions/[id]/effort (browser) and
// /api/agent/sessions/[id]/effort (agent API) so the two surfaces stay identical.

function effortSession(id: string): DeckSession {
	const session = getStoredSession(id);
	if (!session) error(404, 'session not found');
	if (session.kind !== 'claude') error(400, 'only claude sessions have an effort level');
	return session;
}

// Persist immediately; apply on the next turn by dropping the idle claude process
// so the next send respawns with `--resume <claudeSessionId> --effort <new>`. The
// deck.effort marker renders as a transcript line explaining the shift on scroll-back.
function applyEffort(session: DeckSession, effort: DeckEffort | undefined) {
	updateSession(session.id, { effort });
	stopProcess(session.id);
	appendEvent(session.id, { type: 'deck.effort', effort, ts: Date.now() });
}

export async function changeSessionEffort(event: {
	params: Partial<Record<string, string>>;
	request: Request;
}): Promise<Response> {
	const session = effortSession(event.params.id!);
	// objectBody 400s a missing/malformed/null/array/scalar body, so a non-object
	// can't throw a 500 or silently read as a reset; an absent or empty `effort` in
	// a well-formed object is the explicit reset.
	const body = await objectBody(event.request);
	const parsed = parseEffort(body.effort);
	if (!parsed.ok) error(400, 'invalid effort');
	if (agentTurnRunning(session.id)) error(409, 'a turn is running');
	// Unchanged is a no-op so re-picking the current effort doesn't spam markers.
	if (parsed.effort !== session.effort) applyEffort(session, parsed.effort);
	return json({ ok: true });
}
