// Best-effort haptic feedback for touch UI. `navigator.vibrate` is Android /
// Chromium only; iOS Safari (deck's main PWA target) has no web vibration API,
// so this is a silent no-op there. Progressive enhancement, never throws.
export function haptic(pattern: number | number[] = 10): void {
	if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
	try {
		navigator.vibrate(pattern);
	} catch {
		// some engines throw when called outside a user gesture; ignore
	}
}
