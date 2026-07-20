// Pure helpers for rendering a fenced code block to an HTML string. The heavy
// Shiki highlighter is built lazily in build-highlighter.ts; this module only
// decides between a highlighted render and an escaped fallback, and never emits
// unescaped input, so it stays node-free and unit-testable.

// The slice of Shiki's highlighter we use: a synchronous, dual-theme codeToHtml.
export interface DualThemeCodeToHtml {
	codeToHtml(
		code: string,
		options: { lang: string; themes: { light: string; dark: string }; defaultColor: false }
	): string;
}

// Both themes render at once via CSS variables (see the .shiki rules in
// layout.css); we pick which set applies per data-theme, so no re-highlight on
// theme switch. Match the diff viewer's github-light/github-dark.
const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

// Escape the five HTML-significant characters so untrusted fence text or a
// language identifier can never break out of its element/attribute context.
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Escaped, highlighter-free rendering: used before the highlighter has loaded and
// for languages Shiki doesn't know.
function fallback(code: string): string {
	return `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`;
}

// Render a fenced block to a dual-theme Shiki HTML string, or an escaped fallback
// when there's no highlighter, no language, or the language is unknown. Never
// throws: a highlight failure (e.g. an unknown lang mid-stream) degrades to text.
export function highlightToHtml(
	highlighter: DualThemeCodeToHtml | undefined,
	code: string,
	lang: string
): string {
	const l = (lang || '').toLowerCase().trim();
	if (highlighter && l) {
		try {
			return highlighter.codeToHtml(code, {
				lang: l,
				themes: { light: LIGHT_THEME, dark: DARK_THEME },
				defaultColor: false
			});
		} catch {
			// Unknown language or a highlight error: fall through to escaped text.
		}
	}
	return fallback(code);
}
