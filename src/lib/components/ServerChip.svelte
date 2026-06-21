<script lang="ts">
	import type { ServerState } from '$lib/types';
	import { SERVER_BADGE, SERVER_LABEL } from '$lib/servers';
	import { Server } from '@lucide/svelte';

	let { state, count }: { state: ServerState; count?: number } = $props();
</script>

<span class="badge badge-sm shrink-0 gap-1 {SERVER_BADGE[state]}" title="dev servers: {SERVER_LABEL[state]}">
	<Server size={11} />
	{SERVER_LABEL[state]}{#if count && count > 1}<span class="opacity-70">×{count}</span>{/if}
</span>
