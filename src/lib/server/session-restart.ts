import { json, error } from '@sveltejs/kit';
import { getStoredSession } from './store';
import { agentTurnRunning } from './agents/dispatch';
import { appendEvent, stopProcess } from './claude';

// Restart a claude session's process so it re-reads CLI config (CLAUDE.md,
// settings, skills, MCP) that changed since it spawned (issue #228). Dropping the
// idle process is the whole job: the next send respawns it with
// `--resume <claudeSessionId>`, so the conversation continues. Idle-only: a
// running turn is a 409, never an interrupt. claude-only: the other kinds spawn a
// fresh CLI per turn and pick up config anyway. Unlike model and effort there is
// no unchanged case, so this always acts. Shared verbatim by
// /api/sessions/[id]/restart (browser) and /api/agent/sessions/[id]/restart
// (agent API) so the two surfaces stay identical.
export async function restartSession(event: {
	params: Partial<Record<string, string>>;
}): Promise<Response> {
	const session = getStoredSession(event.params.id!);
	if (!session) error(404, 'session not found');
	if (session.kind !== 'claude') error(400, 'only claude sessions have a process to restart');
	if (agentTurnRunning(session.id)) error(409, 'a turn is running');
	stopProcess(session.id);
	// The deck.restart marker renders as a transcript line explaining on scroll-back
	// why config changed mid-conversation. Appended even when no process was alive
	// (idle teardown already dropped it): the marker records the config boundary,
	// not the kill.
	appendEvent(session.id, { type: 'deck.restart', ts: Date.now() });
	return json({ ok: true });
}
