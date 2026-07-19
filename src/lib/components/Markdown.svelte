<script lang="ts">
	// Renders agent/assistant transcript text as GFM Markdown (tables, task lists,
	// strikethrough, autolinked bare URLs). SvelteMarkdown sanitizes URLs and
	// attributes by default (no javascript:, no on* handlers) so we never touch
	// raw {@html}, and in streaming mode it diffs tokens and holds partial syntax,
	// so a half-streamed **bold** or unclosed ``` fence doesn't misrender.
	//
	// Prose styling lives in the global `.markdown` block in layout.css (the
	// rendered nodes come from child components / {@html}, which Svelte's scoped
	// CSS wouldn't reach).
	import SvelteMarkdown from '@humanspeak/svelte-markdown';
	import type { Renderers } from '@humanspeak/svelte-markdown';
	import CodeBlock from '$lib/markdown/CodeBlock.svelte';
	import MdLink from '$lib/markdown/MdLink.svelte';
	import MdListItem from '$lib/markdown/MdListItem.svelte';

	// Hoisted so streaming deltas don't churn a fresh options/renderers identity
	// into SvelteMarkdown on every keystroke.
	const options = { gfm: true, breaks: true };
	const renderers: Partial<Renderers> = { code: CodeBlock, link: MdLink, listitem: MdListItem };

	let {
		source,
		streaming = false,
		streamId
	}: { source: string; streaming?: boolean; streamId?: string | number } = $props();
</script>

<div class="markdown">
	<SvelteMarkdown {source} {streaming} {streamId} {options} {renderers} />
</div>
