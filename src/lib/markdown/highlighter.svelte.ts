// Reactive holder for the lazily-built Shiki highlighter. CodeBlock reads
// renderCode() inside a $derived, so once the async build resolves this $state
// updates and every mounted code block re-renders with real highlighting. Until
// then (and during SSR) renderCode returns escaped plain text.
import { browser } from '$app/environment';
import { highlightToHtml, type DualThemeCodeToHtml } from './highlight-core';

let highlighter = $state<DualThemeCodeToHtml | undefined>(undefined);
let started = false;

// Kick off the one-time async load of the Shiki bundle. Idempotent, and a no-op
// on the server so grammars never load there.
export function ensureHighlighter(): void {
	if (started || !browser) return;
	started = true;
	import('./build-highlighter')
		.then((m) => {
			highlighter = m.buildHighlighter();
		})
		.catch(() => {
			// Highlighting is a progressive enhancement; on failure code stays as
			// escaped text. Clear the flag so a later block can retry the load.
			started = false;
		});
}

export function renderCode(code: string, lang: string): string {
	return highlightToHtml(highlighter, code, lang);
}
