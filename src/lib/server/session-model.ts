import { json, error } from '@sveltejs/kit';
import { isAgentKind, type DeckSession } from '$lib/types';
import { getStoredSession, updateSession } from './store';
import { agentTurnRunning } from './agents/dispatch';
import { appendEvent, stopProcess } from './claude';
import { parseModel } from './session-model-core';

// Switch a session's model mid-session (issue #88). Idle-only: a running turn
// is a 409, never an interrupt. Only agent kinds have a model. Shared verbatim
// by /api/sessions/[id]/model (browser) and /api/agent/sessions/[id]/model
// (agent API) so the two surfaces stay identical, same pattern as
// deleteSessionRoute in http.ts.

function modelSession(id: string): DeckSession {
	const session = getStoredSession(id);
	if (!session) error(404, 'session not found');
	if (!isAgentKind(session.kind)) error(400, 'shell sessions have no model');
	return session;
}

// Persist immediately; apply on the next turn. pi/codex read session.model on
// every per-turn spawn, and claude gets its idle process dropped so the next
// send respawns with `--resume <claudeSessionId> --model <new>` (verified to
// keep the conversation while running the new model). The deck.model marker
// renders as a transcript line explaining any mid-session shift on scroll-back.
function applyModel(session: DeckSession, model: string | undefined) {
	updateSession(session.id, { model });
	if (session.kind === 'claude') stopProcess(session.id);
	appendEvent(session.id, { type: 'deck.model', model, ts: Date.now() });
}

export async function changeSessionModel(event: {
	params: Partial<Record<string, string>>;
	request: Request;
}): Promise<Response> {
	const session = modelSession(event.params.id!);
	// Malformed JSON must 400, not read as "reset to default" (an absent or empty
	// `model` in a well-formed body is the explicit reset).
	const body = (await event.request.json().catch(() => error(400, 'invalid body'))) as {
		model?: unknown;
	};
	const parsed = parseModel(body.model);
	if (!parsed.ok) error(400, 'invalid model');
	if (agentTurnRunning(session.id)) error(409, 'a turn is running');
	// Unchanged is a no-op so re-picking the current model doesn't spam markers.
	if (parsed.model !== session.model) applyModel(session, parsed.model);
	return json({ ok: true });
}
