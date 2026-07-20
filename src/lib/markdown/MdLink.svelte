<script lang="ts">
	// Custom `link` renderer: opens in a new tab with noopener, styled to match
	// deck's Linked component. href is already run through SvelteMarkdown's default
	// URL sanitizer (javascript:/data: stripped) before it reaches here.
	import type { Snippet } from 'svelte';

	let {
		href = undefined,
		title = undefined,
		children
	}: { href?: string; title?: string; children?: Snippet } = $props();
</script>

{#if href}<a
		{href}
		{title}
		target="_blank"
		rel="noopener noreferrer"
		class="link link-primary wrap-anywhere">{@render children?.()}</a
	>{:else}{@render children?.()}{/if}
