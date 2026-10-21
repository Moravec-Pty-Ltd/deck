<script lang="ts">
	import { Code, Check } from '@lucide/svelte';
	import { createCopier } from '$lib/copy.svelte';

	// Header chip that copies the `zed ssh://…` command for the session's cwd, so
	// the worktree can be opened in Zed on whatever machine the browser is on.
	// Copy-only: Zed's SSH remoting has no reliable browser-launchable link, only
	// the documented CLI form.
	let { command }: { command: string } = $props();

	const copier = createCopier();
	const copied = $derived(copier.copied);

	$effect(() => () => copier.stop());
</script>

<button
	type="button"
	class="badge badge-outline badge-sm header-chip shrink-0 gap-1"
	title={copied ? 'Copied' : `Copy: ${command}`}
	onclick={() => copier.copy(command)}
>
	{#if copied}
		<Check size={12} />
	{:else}
		<Code size={12} />
	{/if}
	<span class="hidden sm:inline">{copied ? 'Copied' : 'Zed'}</span>
</button>
