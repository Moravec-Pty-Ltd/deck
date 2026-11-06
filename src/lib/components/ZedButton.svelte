<script lang="ts">
	import { Code, Check, Copy } from '@lucide/svelte';
	import { createCopier } from '$lib/copy.svelte';

	// Header control for the session's cwd: a link that opens it in Zed over SSH,
	// plus the `zed ssh://…` command for a machine the link cannot reach (a browser
	// cannot tell whether Zed is installed).
	let { command, url }: { command: string; url: string } = $props();

	const copier = createCopier();
	const copied = $derived(copier.copied);

	$effect(() => () => copier.stop());
</script>

<div class="join shrink-0">
	<a class="btn btn-outline join-item btn-xs header-chip gap-1" href={url} title="Open in Zed" aria-label="Open in Zed">
		<Code size={12} />
		<span class="hidden sm:inline">Zed</span>
	</a>
	<button
		type="button"
		class="btn btn-outline join-item btn-xs header-chip"
		title={copied ? 'Copied' : `Copy: ${command}`}
		aria-label={copied ? 'Copied' : 'Copy the Zed command'}
		onclick={() => copier.copy(command)}
	>
		{#if copied}
			<Check size={12} />
		{:else}
			<Copy size={12} />
		{/if}
	</button>
</div>
