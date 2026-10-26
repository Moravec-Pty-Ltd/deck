import { getStoredSession, listProjects, listStoredSessions, updateSession } from './store';
import { hiddenSessionIds } from './hidden';
import { stampHidden } from '$lib/hidden-core';
import { unreadCount } from '$lib/unread-core';
import { publishAgentEvent } from './agent-feed';
import { apnsBadge } from './apns';

// Unread state lives on the session record, so only a stored session can be
// unread; an adhoc terminal never notifies anyway.

export function currentUnreadCount(): number {
	return unreadCount(stampHidden(listStoredSessions(), hiddenSessionIds(), listProjects()));
}

function setUnread(id: string, unread: boolean): boolean {
	const session = getStoredSession(id);
	if (!session || !!session.unread === unread) return false;
	updateSession(id, { unread: unread || undefined });
	publishAgentEvent(id, 'session-unread', { unread });
	return true;
}

// Called by notify() for every session notification it sends.
export function markUnread(id: string): void {
	setUnread(id, true);
}

// Pushes the count to the phones and Macs, so their icons follow without the
// app being opened. Called after anything that can move it (a read, a hide, a
// delete), all rare enough to push every time.
export function syncBadge(): number {
	const count = currentUnreadCount();
	void apnsBadge(count);
	return count;
}

export function markRead(ids: string[]): number {
	for (const id of ids) setUnread(id, false);
	return syncBadge();
}
