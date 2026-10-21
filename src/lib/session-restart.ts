import { agentPost, sessionPath } from '$lib/agent-api';

// Restart a claude session's process (see server/session-restart.ts). Shared by
// AgentMenu and the command palette; throws with the server's message on failure
// so callers can show it inline.
export async function restartSession(id: string): Promise<void> {
	await agentPost(sessionPath(id, 'restart'));
}
