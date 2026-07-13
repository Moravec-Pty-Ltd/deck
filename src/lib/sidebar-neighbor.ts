import type { DeckSession } from '$lib/types';
import type { SessionGroup } from '$lib/groups';
import type { StatusBucket, StatusBucketKey } from '$lib/status-groups';

// Flatten the sidebar's "By project" view into the session order it actually
// renders: groups in order, each expanded group's subgroups in order, their
// sessions in order. Collapsed groups contribute nothing (their rows are off
// screen), so `isExpanded` mirrors the sidebar's collapse state.
export function flattenVisibleGroups(
	groups: SessionGroup[],
	isExpanded: (name: string) => boolean
): DeckSession[] {
	const order: DeckSession[] = [];
	for (const group of groups) {
		if (!isExpanded(group.name)) continue;
		for (const sub of group.subgroups) order.push(...sub.sessions);
	}
	return order;
}

// Flatten the sidebar's "By status" view the same way: buckets in order, each
// open bucket's sessions in order. Status buckets default open, so `isCollapsed`
// is the inverse predicate the sidebar tracks.
export function flattenVisibleBuckets(
	buckets: StatusBucket[],
	isCollapsed: (key: StatusBucketKey) => boolean
): DeckSession[] {
	const order: DeckSession[] = [];
	for (const bucket of buckets) {
		if (isCollapsed(bucket.key)) continue;
		order.push(...bucket.sessions);
	}
	return order;
}

// The visible row to land on after removing `id` from an ordered, on-screen
// list: the row just below, else the row just above, else null (the list
// emptied, so the caller navigates home).
export function pickNeighbor(order: DeckSession[], id: string): DeckSession | null {
	const i = order.findIndex((s) => s.id === id);
	if (i === -1) return null;
	return order[i + 1] ?? order[i - 1] ?? null;
}
