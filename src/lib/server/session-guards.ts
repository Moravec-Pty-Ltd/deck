import { error } from '@sveltejs/kit';
import type { DeckSession } from '$lib/types';
import { getStoredSession } from './store';
import { agentTurnRunning } from './agents/dispatch';

// The checks a per-session claude route makes before it acts: the session
// exists, it is a claude session (the others have no CLI process or `/compact`
// to speak to), and it is between turns. Shared by the restart and compact
// routes, which differ only in what they say about the wrong kind.
export function idleClaudeSession(id: string | undefined, wrongKind: string): DeckSession {
	const session = getStoredSession(id!);
	if (!session) error(404, 'session not found');
	if (session.kind !== 'claude') error(400, wrongKind);
	if (agentTurnRunning(session.id)) error(409, 'a turn is running');
	return session;
}
