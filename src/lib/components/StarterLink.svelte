<script lang="ts">
	import { starterSession } from '$lib/workflow-view';
	import type { RunDigest } from '$lib/workflows';

	let { run }: { run: RunDigest } = $props();
	const session = $derived(starterSession(run));
</script>

{#if session?.title !== undefined}
	<a class="link link-hover min-w-0 truncate" href="/s/{encodeURIComponent(session.sessionId)}">{session.title}</a>
{:else if session}
	<span class="opacity-60">a deleted session</span>
{/if}
