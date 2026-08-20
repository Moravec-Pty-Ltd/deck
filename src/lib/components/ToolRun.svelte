<script lang="ts">
	import { ChevronRight } from '@lucide/svelte';
	import { toolIcon } from '$lib/tool-icons';
	import RollingCount from './RollingCount.svelte';

	// The one line a run of tool calls collapses to in the Chat tab. Click to
	// expand the calls in place.
	let {
		count,
		tools,
		open,
		ontoggle
	}: { count: number; tools: string[]; open: boolean; ontoggle: () => void } = $props();
</script>

<button
	class="flex w-full items-center gap-2 px-2 text-left text-xs opacity-60 hover:opacity-100"
	onclick={ontoggle}
	aria-expanded={open}
>
	<ChevronRight size={12} class="shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
	<span class="flex items-center gap-1"><RollingCount value={count} /> tool calls</span>
	<!-- After the count, so a live run picking up a new tool doesn't shift the
	     number. Capped so a long, varied run still reads as one quiet line. -->
	{#each tools.slice(0, 6) as name (name)}
		{@const Icon = toolIcon(name)}
		<Icon size={12} class="shrink-0" />
	{/each}
</button>
