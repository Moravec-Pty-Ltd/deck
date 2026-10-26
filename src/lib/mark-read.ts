import { agentPath, agentPost } from '$lib/agent-api';

// Clear sessions' unread markers (issue #336). Fire-and-forget: the feed's
// session-unread events update every list, and a failed call leaves the marker
// for the next open to clear.
export function markRead(ids: string[]): void {
	if (ids.length) agentPost(agentPath('/sessions/read'), { ids }).catch(() => {});
}
