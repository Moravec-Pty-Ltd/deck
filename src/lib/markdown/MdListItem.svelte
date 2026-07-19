<script lang="ts">
	// Custom list-item renderer so GFM task-list items (`- [x] done`) show a
	// disabled checkbox reflecting their state; the default renderer drops the
	// marker entirely. Covers ordered and unordered lists (the parser falls back to
	// `listitem` for both).
	import type { Snippet } from 'svelte';

	let {
		task = false,
		checked = false,
		children
	}: { task?: boolean; checked?: boolean; children?: Snippet } = $props();
</script>

{#if task}
	<li><input type="checkbox" {checked} disabled />{@render children?.()}</li>
{:else}
	<li>{@render children?.()}</li>
{/if}
