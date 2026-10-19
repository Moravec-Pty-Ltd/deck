<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		id,
		title,
		description,
		children
	}: { id: string; title: string; description: string; children: Snippet } = $props();
</script>

<section {id} aria-labelledby="{id}-heading" class="scroll-mt-4">
	<h2 id="{id}-heading" class="m-0 text-sm font-semibold tracking-tight">{title}</h2>
	<p class="mt-0.5 mb-2.5 text-xs opacity-70">{description}</p>
	{@render children()}
</section>
