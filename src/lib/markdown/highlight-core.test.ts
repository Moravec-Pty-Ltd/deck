import { describe, expect, it } from 'vitest';
import { escapeHtml, highlightToHtml, type DualThemeCodeToHtml } from './highlight-core';

// A stub standing in for Shiki: records the call and returns marker HTML, so the
// tests exercise this module's branching without loading real grammars.
function stub(html = '<pre class="shiki">HL</pre>'): DualThemeCodeToHtml & { calls: unknown[] } {
	const calls: unknown[] = [];
	return {
		calls,
		codeToHtml(code, options) {
			calls.push({ code, options });
			return html;
		}
	};
}

describe('escapeHtml', () => {
	it('escapes the five HTML-significant characters', () => {
		expect(escapeHtml(`<script>&"'`)).toBe('&lt;script&gt;&amp;&quot;&#39;');
	});
});

describe('highlightToHtml', () => {
	it('highlights a known language via the highlighter', () => {
		const hl = stub('<pre class="shiki">ok</pre>');
		expect(highlightToHtml(hl, 'const x = 1', 'ts')).toBe('<pre class="shiki">ok</pre>');
		expect(hl.calls).toHaveLength(1);
		expect(hl.calls[0]).toMatchObject({
			code: 'const x = 1',
			options: { lang: 'ts', themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false }
		});
	});

	it('lower-cases and trims the language before highlighting', () => {
		const hl = stub();
		highlightToHtml(hl, 'x', '  TypeScript  ');
		expect(hl.calls[0]).toMatchObject({ options: { lang: 'typescript' } });
	});

	it('falls back to escaped text when there is no highlighter yet', () => {
		expect(highlightToHtml(undefined, 'a < b', 'ts')).toBe(
			'<pre class="shiki-fallback"><code>a &lt; b</code></pre>'
		);
	});

	it('falls back to escaped text for a fenced block with no language', () => {
		const hl = stub();
		expect(highlightToHtml(hl, 'plain', '')).toBe(
			'<pre class="shiki-fallback"><code>plain</code></pre>'
		);
		expect(hl.calls).toHaveLength(0);
	});

	it('falls back (never throws) when the highlighter throws on an unknown lang', () => {
		const hl: DualThemeCodeToHtml = {
			codeToHtml() {
				throw new Error('unknown language');
			}
		};
		expect(highlightToHtml(hl, 'code', 'made-up')).toBe(
			'<pre class="shiki-fallback"><code>code</code></pre>'
		);
	});

	it('escapes an XSS payload in the code so it cannot break out of the fallback', () => {
		const html = highlightToHtml(undefined, '</code></pre><script>alert(1)</script>', 'ts');
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('</code></pre><script>');
		expect(html).toContain('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;');
	});
});
