<script lang="ts">
	// Custom `code` renderer for SvelteMarkdown: highlights fenced blocks with
	// Shiki (dual github-light/github-dark themes via CSS variables, styled in
	// layout.css) and falls back to escaped plain text before the highlighter
	// loads or for unknown languages. The wrapper carries a copy button, which
	// copies the fence text verbatim rather than the rendered markup.
	import { Check, Copy } from '@lucide/svelte';
	import { ensureHighlighter, renderCode } from '$lib/markdown/highlighter.svelte';
	import { createCopier } from '$lib/copy.svelte';

	let { lang, text }: { lang: string; text: string } = $props();

	ensureHighlighter();
	// Safe {@html}: renderCode returns Shiki-generated or escaped markup, never the
	// raw fence text/lang (see highlight-core.ts).
	const html = $derived(renderCode(text, lang ?? ''));

	const copier = createCopier();
	$effect(() => () => copier.stop());

	// The enclosing message bubble copies the whole message on a long press. Keep
	// a hold on this button to the block under the finger instead.
	function swallow(e: PointerEvent) {
		e.stopPropagation();
	}
</script>

<div class="code-block">
	{@html html}
	<button
		type="button"
		class="code-copy btn btn-ghost btn-xs"
		class:copied={copier.copied}
		onclick={() => copier.copy(text)}
		onpointerdown={swallow}
		aria-label="Copy code"
		title="Copy code"
	>
		{#if copier.copied}<Check size={13} />{:else}<Copy size={13} />{/if}
	</button>
</div>
