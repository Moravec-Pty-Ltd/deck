import type { Action } from 'svelte/action';

// Close a header dropdown/popover on any pointerdown outside it. Capture phase,
// so a click that a menu item swallows still dismisses sibling dropdowns.
// Shared by the <details>-based header menus.
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

// Shift a 1-D interval [start, end] so it sits within [min, max]; returns the
// offset to add. If the interval is wider than the slot it pins the start to
// `min`, keeping the leading edge visible (clip the trailing edge, not the
// content you read first). Pure, so the geometry is unit-tested without a DOM.
export function shift1d(start: number, end: number, min: number, max: number): number {
	if (end - start > max - min) return min - start;
	if (end > max) return max - end;
	if (start < min) return min - start;
	return 0;
}

// Keep a daisyUI `dropdown-content` inside the viewport (issue #122). daisyUI's
// dropdowns are statically positioned and don't collision-detect, so a fixed-
// width menu opened from a trigger near a screen edge simply clips off it. While
// open — on the initial open, on resize / orientation change, and when the
// content itself resizes (e.g. a menu that swaps panels) — cap the content to
// the viewport and translate any overflow back inside with a small edge margin.
// Dependency-free and works on iOS Safari / the installed PWA, where native CSS
// anchor positioning isn't reliable yet. Apply to the `.dropdown-content`
// element inside a <details> dropdown.
export const keepInView: Action<HTMLElement> = (node) => {
	const MARGIN = 8; // px gap kept from each viewport edge
	const details = node.closest('details');
	let observer: ResizeObserver | undefined;

	// Author-set caps (e.g. a Tailwind `max-h-*`) read once before we write any
	// inline style, so the viewport cap only ever tightens them — it never
	// enlarges a menu the component already bounded.
	let authorMaxW = Infinity;
	let authorMaxH = Infinity;
	let capsRead = false;
	function readCap(value: string): number {
		const n = parseFloat(value);
		return Number.isFinite(n) ? n : Infinity;
	}

	// Measure with the open animation neutralised: daisyUI transitions the `scale`
	// property 95%→100% on open, so a synchronous read mid-transition reports a
	// slightly shrunk box. Snapping scale to 1 (transitions off) for the read
	// gives the settled geometry; the inline styles are restored right after.
	// `transform` is already 'none' here (set by adjust) so the box is un-shifted.
	function measure(): DOMRect {
		const { transition, scale } = node.style;
		node.style.transition = 'none';
		node.style.scale = '1';
		const rect = node.getBoundingClientRect();
		node.style.transition = transition;
		node.style.scale = scale;
		return rect;
	}

	function reset() {
		node.style.maxWidth = '';
		node.style.maxHeight = '';
		node.style.overflowY = '';
		node.style.transform = '';
	}

	// Deterministic for a given viewport (no reset-then-remeasure), so re-running
	// under the ResizeObserver converges instead of thrashing the element's size.
	function adjust() {
		// Drawer mode (Popover.svelte below sm): the panel is repositioned as a
		// fixed bottom sheet by CSS, which owns its geometry entirely. Clear any
		// overrides a desktop-mode run left behind and step aside.
		if (getComputedStyle(node).position === 'fixed') {
			reset();
			return;
		}
		if (!capsRead) {
			authorMaxW = readCap(getComputedStyle(node).maxWidth);
			authorMaxH = readCap(getComputedStyle(node).maxHeight);
			capsRead = true;
		}
		const vw = document.documentElement.clientWidth;
		const vh = document.documentElement.clientHeight;
		// Cap to the viewport (or the author's tighter cap) so an over-wide/tall
		// menu can then be shifted fully in; overflow-y lets a clamped menu scroll.
		node.style.maxWidth = `${Math.min(authorMaxW, vw - 2 * MARGIN)}px`;
		node.style.maxHeight = `${Math.min(authorMaxH, vh - 2 * MARGIN)}px`;
		node.style.overflowY = 'auto';
		node.style.transform = 'none'; // measure the un-shifted position
		const r = measure();
		const dx = shift1d(r.left, r.right, MARGIN, vw - MARGIN);
		const dy = shift1d(r.top, r.bottom, MARGIN, vh - MARGIN);
		node.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
	}

	function onToggle() {
		if (details?.open) {
			adjust();
			observer ??= new ResizeObserver(() => adjust());
			observer.observe(node);
			window.addEventListener('resize', adjust);
			window.addEventListener('orientationchange', adjust);
		} else {
			observer?.disconnect();
			window.removeEventListener('resize', adjust);
			window.removeEventListener('orientationchange', adjust);
			reset();
		}
	}

	details?.addEventListener('toggle', onToggle);
	if (details?.open) onToggle(); // handle a rare already-open mount

	return {
		destroy() {
			details?.removeEventListener('toggle', onToggle);
			observer?.disconnect();
			window.removeEventListener('resize', adjust);
			window.removeEventListener('orientationchange', adjust);
		}
	};
};
