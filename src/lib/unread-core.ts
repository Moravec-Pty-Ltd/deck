// A session is unread from the moment deck notifies you about it until you
// open it or answer its question (issue #336). The badge on the app icon counts
// these. A hidden session never notifies, so one hidden after the fact drops out
// of the count too. Shared by the server's badge, the web page's badge and the
// apps (DeckStore.unreadCount), so every surface shows the same number.
export function unreadCount(sessions: { unread?: boolean; hidden?: boolean }[]): number {
	return sessions.filter((s) => s.unread && !s.hidden).length;
}
