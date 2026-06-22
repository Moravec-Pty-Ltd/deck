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
			if (browser) localStorage.setItem(key, JSON.stringify([...next]));
		}
	};
}
