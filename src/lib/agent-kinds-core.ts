import type { SessionKind } from './types';

// Which agent kinds a picker offers. Only a positive "not installed" hides one:
// null availability (not fetched yet, or the fetch failed) shows everything, and
// shell never appears in the listing so it always shows. `current`, the kind a
// session or lane already uses, stays listed so its setting can't change silently.
export function kindShown(
	kind: SessionKind,
	availability: Partial<Record<SessionKind, boolean>> | null,
	current?: SessionKind
): boolean {
	return kind === current || availability?.[kind] !== false;
}
