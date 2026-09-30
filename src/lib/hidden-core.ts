import type { DeckSession, Project } from '$lib/types';
import { deriveGroup } from '$lib/time';

// Hiding, the pure half. A hidden session or project drops out of the ordinary
// lists and turns up in the "Hidden" section at the bottom instead, where it can
// be brought back. Nothing stops running and nothing is deleted.
//
// Two things can hide a session: the session itself, and the project it sits in.
// The server folds both into the one `hidden` flag it stamps on each session
// (see server/hidden.ts) so no client has to re-derive the rule.

// The paths of the projects the user has hidden.
export function hiddenProjectPaths(projects: Project[]): Set<string> {
	return new Set(projects.filter((p) => p.hidden).map((p) => p.path));
}

// Stamp `hidden` on each session that is hidden itself or sits in a hidden
// project. deriveGroup folds a worktree back onto its repo, so a session working
// in a worktree hides with the project it branched from.
export function stampHidden(
	sessions: DeckSession[],
	hiddenIds: Set<string>,
	projects: Project[]
): DeckSession[] {
	const paths = hiddenProjectPaths(projects);
	if (hiddenIds.size === 0 && paths.size === 0) return sessions;
	return sessions.map((s) =>
		hiddenIds.has(s.id) || paths.has(deriveGroup(s.cwd, projects).key) ? { ...s, hidden: true } : s
	);
}

// Add or drop an id. Sorted and de-duplicated so toggling the same session twice
// leaves the stored file byte-identical.
export function withHidden(ids: string[], id: string, hidden: boolean): string[] {
	const set = new Set(ids);
	if (hidden) set.add(id);
	else set.delete(id);
	return [...set].sort();
}

// The sessions the ordinary lists show.
export function visibleSessions(sessions: DeckSession[]): DeckSession[] {
	return sessions.filter((s) => !s.hidden);
}
