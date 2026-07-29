// Pure logic for the shared session grouping mode (issue #206). The sidebar and
// the homepage read one persisted setting, so toggling either changes both. No
// DOM or localStorage here; the rune store in view-mode.svelte.ts owns those.

export type ViewMode = 'project' | 'status';

export const VIEW_KEY = 'deck:viewMode';

// The sidebar's original per-surface key, read once as a fallback so an existing
// choice carries over on first load after upgrade.
export const LEGACY_VIEW_KEY = 'deck:sidebar:viewMode';

// Resolve the persisted mode, preferring the shared key over the legacy one.
// Anything unrecognised (absent, corrupt) falls back to "by project".
export function parseViewMode(raw: string | null, legacy: string | null): ViewMode {
	return (raw || legacy) === 'status' ? 'status' : 'project';
}

export function nextViewMode(mode: ViewMode): ViewMode {
	return mode === 'project' ? 'status' : 'project';
}

// The toggle's label, shared so both surfaces read identically: it names the
// mode you'd switch *to*.
export function viewModeLabel(mode: ViewMode): string {
	return mode === 'project' ? 'Group by status' : 'Group by project';
}
