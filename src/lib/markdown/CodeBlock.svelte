<script lang="ts">
	// Custom `code` renderer for SvelteMarkdown: highlights fenced blocks with
	// Shiki (dual github-light/github-dark themes via CSS variables, styled in
	// layout.css) and falls back to escaped plain text before the highlighter
	// loads or for unknown languages.
	import { ensureHighlighter, renderCode } from '$lib/markdown/highlighter.svelte';

	let { lang, text }: { lang: string; text: string } = $props();

	ensureHighlighter();
	// Safe {@html}: renderCode returns Shiki-generated or escaped markup, never the
	// raw fence text/lang (see highlight-core.ts).
	const html = $derived(renderCode(text, lang ?? ''));
</script>

{@html html}
