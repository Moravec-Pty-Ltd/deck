// Pure width math for the resizable desktop sidebar (issue #52). The sidebar is
// a fixed lg:w-56 (14rem / 224px) column by default; dragging its right edge
// resizes it within a clamp range. No DOM or localStorage here so it stays
// unit-testable; the component owns the pointer wiring and persistence.

export const SIDEBAR_MIN = 192; // 12rem
export const SIDEBAR_MAX = 448; // 28rem
export const SIDEBAR_DEFAULT = 224; // 14rem, matches the old lg:w-56

// Clamp to [MIN, MAX] and round to whole px. Non-finite input -> default.
export function clampSidebarWidth(px: number): number {
	if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
	return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
}

// Parse a persisted value (a localStorage string or null) to a clamped width,
// falling back to the default when it's absent or unparseable.
export function parseSidebarWidth(raw: string | null): number {
	if (raw === null) return SIDEBAR_DEFAULT;
	const n = Number.parseInt(raw, 10);
	return Number.isNaN(n) ? SIDEBAR_DEFAULT : clampSidebarWidth(n);
}
