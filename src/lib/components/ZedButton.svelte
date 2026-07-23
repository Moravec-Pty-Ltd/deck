<script lang="ts">
	import { Code, Check } from '@lucide/svelte';

	// Header chip that copies the `zed ssh://…` command for the session's cwd, so
	// the worktree can be opened in Zed on whatever machine the browser is on.
	// Copy-only: Zed's SSH remoting has no reliable browser-launchable link, only
	// the documented CLI form.
	let { command }: { command: string } = $props();

	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		if (!navigator.clipboard) return;
		try {
			await navigator.clipboard.writeText(command);
		} catch {
			return; // don't flash the tick if the write failed
		}
		copied = true;
		clearTimeout(resetTimer);
		resetTimer = setTimeout(() => (copied = false), 1000);
	}
</script>

<button
	type="button"
	class="badge badge-outline badge-sm shrink-0 gap-1"
	title={copied ? 'Copied' : `Copy: ${command}`}
	onclick={copy}
>
	{#if copied}
		<Check size={12} />
	{:else}
		<Code size={12} />
	{/if}
	<span class="hidden sm:inline">{copied ? 'Copied' : 'Zed'}</span>
</button>
