// Restart a claude session's process (see server/session-restart.ts). Shared by
// AgentMenu and the command palette; throws with the server's message on failure
// so callers can show it inline.
export async function restartSession(id: string): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/restart`, { method: 'POST' });
	if (!res.ok) {
		const data = await res.json().catch(() => null);
		throw new Error(data?.message || 'restart failed');
	}
}
