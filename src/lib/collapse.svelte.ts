import { browser } from '$app/environment';

// A localStorage-backed set of *expanded* group names (absent = collapsed) for
// the collapsible project-groups (issue #34). Default-collapsed, no auto-expand.
// The sidebar and homepage each create one with their own key so their collapse
// states stay independent.
export function createCollapseState(key: string) {
	function load(): Set<string> {
		if (!browser) return new Set();
		try {
			const raw = localStorage.getItem(key);
			return new Set(raw ? (JSON.parse(raw) as string[]) : []);
		} catch {
			return new Set();
		}
	}
	let expanded = $state<Set<string>>(load());
	return {
		has(name: string): boolean {
			return expanded.has(name);
		},
		toggle(name: string) {
			const next = new Set(expanded);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			expanded = next;
			// Persist best-effort: a write can throw in private mode or when the quota
			// is exceeded, and that mustn't abort the expand/collapse click.
			if (browser) {
				try {
					localStorage.setItem(key, JSON.stringify([...next]));
				} catch {
					// Keep the in-memory state; persistence is non-critical.
				}
			}
		}
	};
}
