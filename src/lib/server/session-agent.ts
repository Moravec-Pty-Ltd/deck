import { randomUUID } from 'node:crypto';
import { error, json } from '@sveltejs/kit';
import { getStoredSession, updateSession } from './store';
import { objectBody } from './http';
import { agentTurnRunning } from './agents/dispatch';
import { agentAvailability } from './agents/available';
import { appendEvent, stopProcess } from './claude';
import { agentTranscriptView, transcriptPath } from './transcript';
import { whenDrained } from './transcript-writer';
import { agentSwitchPatch, handoffContext, parseAgent } from './session-agent-core';

export async function changeSessionAgent(event: {
	params: Partial<Record<string, string>>;
	request: Request;
}): Promise<Response> {
	const id = event.params.id!;
	const body = await objectBody(event.request);
	const kind = parseAgent(body.kind);
	if (!kind) error(400, 'invalid agent');
	const available = await agentAvailability();
	if (!available[kind]) error(400, `${kind} is not installed`);
	await whenDrained(transcriptPath(id));
	// Re-read after asynchronous work so a newly started turn cannot be switched.
	const session = getStoredSession(id);
	if (!session) error(404, 'session not found');
	if (session.kind === 'shell') error(400, 'shell sessions cannot switch agents');
	if (agentTurnRunning(id)) error(409, 'a turn is running');
	if (session.kind === kind) return json({ ok: true });
	const from = session.kind;
	const context = handoffContext(agentTranscriptView(id).messages);
	stopProcess(id);
	updateSession(id, agentSwitchPatch(kind, randomUUID(), context));
	appendEvent(id, { type: 'deck.agent', from, kind, ts: Date.now() });
	return json({ ok: true });
}
