import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentKind, type DeckSession } from '$lib/types';
import { getStoredSession, updateSession } from '$lib/server/store';
import { agentTurnRunning } from '$lib/server/agents/dispatch';
import { isFlagSafe } from '$lib/server/agents/args';
import { appendEvent, stopProcess } from '$lib/server/claude';

// Switch a session's model mid-session (issue #88). Idle-only: a running turn
// is a 409, never an interrupt. Only agent kinds have a model.

function agentSession(id: string): DeckSession {
	const session = getStoredSession(id);
	if (!session) error(404, 'session not found');
	if (!isAgentKind(session.kind)) error(400, 'shell sessions have no model');
	return session;
}

// Absent resets to the CLI default; anything else must be a string.
function parseModel(raw: unknown): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== 'string') error(400, 'invalid model');
	return normalizeModel(raw);
}

// Empty also resets; a leading dash would be read as a flag by the spawned
// agent (same guard the spawn sites apply, see agents/args.ts).
function normalizeModel(raw: string): string | undefined {
	const model = raw.trim();
	if (!model) return undefined;
	if (!isFlagSafe(model)) error(400, 'invalid model');
	return model;
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

export const POST: RequestHandler = async ({ params, request }) => {
	const session = agentSession(params.id);
	const body = (await request.json().catch(() => ({}))) as { model?: unknown };
	const model = parseModel(body.model);
	if (agentTurnRunning(session.id)) error(409, 'a turn is running');
	// Unchanged is a no-op so re-picking the current model doesn't spam markers.
	if (model !== session.model) applyModel(session, model);
	return json({ ok: true });
};
