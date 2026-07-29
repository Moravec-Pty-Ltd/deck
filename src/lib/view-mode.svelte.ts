import { browser } from '$app/environment';
import { LEGACY_VIEW_KEY, VIEW_KEY, nextViewMode, parseViewMode, type ViewMode } from './view-mode';

// One module-level rune shared by every importer, so the sidebar and homepage
// toggles drive the same state and stay in sync without prop plumbing.
function load(): ViewMode {
	if (!browser) return 'project';
	try {
		return parseViewMode(localStorage.getItem(VIEW_KEY), localStorage.getItem(LEGACY_VIEW_KEY));
	} catch {
		return 'project';
	}
}

let mode = $state<ViewMode>(load());

export const viewMode = {
	get current(): ViewMode {
		return mode;
	},
	toggle() {
		mode = nextViewMode(mode);
		// Persist best-effort: a write can throw in private mode or when the quota
		// is exceeded, and that mustn't undo the click.
		if (browser) {
			try {
				localStorage.setItem(VIEW_KEY, mode);
			} catch {
				// Keep the in-memory choice; persistence is non-critical.
			}
		}
	}
};
