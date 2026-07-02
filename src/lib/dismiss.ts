import type { Action } from 'svelte/action';

// Close a header dropdown/popover on any pointerdown outside it. Capture phase,
// so a click that a menu item swallows still dismisses sibling dropdowns.
// Shared by the <details>-based menus (PrMenu, QuickMessages, ModelMenu).
export const dismissOnOutside: Action<HTMLElement, () => void> = (node, close) => {
	function onDown(e: PointerEvent) {
		if (!node.contains(e.target as Node)) close();
	}
	window.addEventListener('pointerdown', onDown, true);
	return {
		destroy() {
			window.removeEventListener('pointerdown', onDown, true);
		}
	};
};
