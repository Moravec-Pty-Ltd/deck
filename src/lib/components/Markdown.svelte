<script lang="ts">
	// Renders agent/assistant transcript text as GFM Markdown (tables, task lists,
	// strikethrough, autolinked bare URLs). SvelteMarkdown sanitizes URLs and
	// attributes (no javascript:, only inert tags, see inert-html.ts) so we never touch
	// raw {@html}, and in streaming mode it diffs tokens and holds partial syntax,
	// so a half-streamed **bold** or unclosed ``` fence doesn't misrender.
	//
	// Prose styling lives in the global `.markdown` block in layout.css (the
	// rendered nodes come from child components / {@html}, which Svelte's scoped
	// CSS wouldn't reach).
	import SvelteMarkdown, { allowHtmlOnly } from '@humanspeak/svelte-markdown';
	import type { Renderers } from '@humanspeak/svelte-markdown';
	import { INERT_TAGS, inertAttributes } from '$lib/markdown/inert-html';
	import CodeBlock from '$lib/markdown/CodeBlock.svelte';
	import MdLink from '$lib/markdown/MdLink.svelte';
	import MdListItem from '$lib/markdown/MdListItem.svelte';

	// Hoisted so streaming deltas don't churn a fresh options/renderers identity
	// into SvelteMarkdown on every keystroke.
	const options = { gfm: true, breaks: true, headerIds: false };
	const renderers: Partial<Renderers> = { code: CodeBlock, link: MdLink, listitem: MdListItem, html: allowHtmlOnly(INERT_TAGS as Parameters<typeof allowHtmlOnly>[0]) };

	let {
		source,
		streaming = false,
		streamId
	}: { source: string; streaming?: boolean; streamId?: string | number } = $props();
</script>

<div class="markdown">
	<SvelteMarkdown {source} {streaming} {streamId} {options} {renderers} sanitizeAttributes={inertAttributes} />
</div>
