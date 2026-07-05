import { error } from '@sveltejs/kit';
import { isAgentKind, type DeckSession } from '$lib/types';
import { getSession } from './sessions';

// Parse a JSON request body, asserting it is a plain object. Replies 400 on a
// missing, malformed, null, primitive, or array body so handlers can read
// fields without guarding each access.
export async function objectBody(request: Request): Promise<Record<string, unknown>> {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body)) error(400, 'invalid request body');
	return body as Record<string, unknown>;
}

// The agent session a per-session action route targets, or a 404. Shells (and
// unknown ids) have no asks, workflows, or turns to act on.
export async function agentSessionOr404(id: string): Promise<DeckSession> {
	const session = await getSession(id);
	if (!session || !isAgentKind(session.kind)) error(404, 'session not found');
	return session;
}
