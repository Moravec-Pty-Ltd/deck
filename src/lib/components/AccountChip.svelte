<script lang="ts">
	import { CircleUser } from '@lucide/svelte';
	import type { DeckSession } from '$lib/types';

	// The Claude account a session runs under, shown only when it isn't Default.
	let { session, class: klass = '' }: { session: Pick<DeckSession, 'kind' | 'account'>; class?: string } = $props();
</script>

{#if session.kind === 'claude' && session.account}
	<span
		class="badge badge-ghost badge-sm min-w-0 shrink gap-1 {klass}"
		title="Claude account: {session.account}"
	>
		<CircleUser size={12} class="shrink-0" />
		<span class="truncate">{session.account}</span>
	</span>
{/if}
