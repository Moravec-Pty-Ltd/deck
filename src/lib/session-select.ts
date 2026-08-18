import type { DeckSession } from './types';

// Pure helpers for the homepage's multi-select (issue #211). They all work on the
// flattened *visible* order of the current view, which the sidebar's flatteners
// already produce (see sidebar-neighbor.ts), so a range or a Select All follows
// exactly the rows on screen rather than the raw session list.

// The contiguous run of ids between two rows, inclusive of both ends and
// direction-agnostic, for a shift-click. Empty when either row isn't on screen (a
// poll dropped it, or it's inside a collapsed section), so the caller falls back
// to a plain toggle.
export function rangeIds(order: DeckSession[], anchorId: string, toId: string): string[] {
	const a = order.findIndex((s) => s.id === anchorId);
	const b = order.findIndex((s) => s.id === toId);
	if (a === -1 || b === -1) return [];
	return order.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id);
}

// The selected ids that are no longer on the list, for the caller to drop. The
// homepage repolls every 5s and its filter can change under a live selection, so
// without this a row the user can't see any more would still be in the Remove
// count, and in the batch.
export function staleIds(selected: Iterable<string>, sessions: DeckSession[]): string[] {
	const live = new Set(sessions.map((s) => s.id));
	return [...selected].filter((id) => !live.has(id));
}

// Whether every visible row is picked, which flips Select All to Deselect All.
// False for an empty list, so an empty action bar never reads as "all picked".
export function allSelected(order: DeckSession[], selected: ReadonlySet<string>): boolean {
	return order.length > 0 && order.every((s) => selected.has(s.id));
}
