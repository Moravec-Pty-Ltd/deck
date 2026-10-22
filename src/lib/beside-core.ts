// The session shown beside the main one (`?beside=<id>`): valid only while it is
// a live session other than the page's own.
export function resolveBeside<T extends { id: string }>(
	raw: string | null,
	currentId: string,
	sessions: T[]
): T | null {
	if (!raw || raw === currentId) return null;
	return sessions.find((s) => s.id === raw) ?? null;
}
