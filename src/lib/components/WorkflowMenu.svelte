<script lang="ts">
	import type { Workflow } from '$lib/types';
	import { dismissOnOutside } from '$lib/dismiss';
	import { Play, Workflow as WorkflowIcon } from '@lucide/svelte';

	// "Run workflow here" (issue #111): start one of the project's configured
	// workflows on this session — the finish-an-existing-worktree entry point.
	// Only configured workflows are offered (the legacy synthesized pair is the
	// new-session path, not a run).
	let {
		sessionId,
		workflows,
		onChange
	}: { sessionId: string; workflows: Workflow[]; onChange: () => void } = $props();

	let open = $state(false);
	let busy = $state(false);
	let err = $state('');

	$effect(() => {
		if (!open) err = '';
	});

	async function start(workflowId: string) {
		if (busy) return;
		busy = true;
		err = '';
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/workflow`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ workflowId })
			});
			if (!res.ok) {
				err = (await res.json().catch(() => null))?.message || 'failed to start';
				return;
			}
			open = false;
			onChange();
		} finally {
			busy = false;
		}
	}
</script>

<details class="dropdown dropdown-end" bind:open use:dismissOnOutside={() => (open = false)}>
	<summary class="btn btn-ghost btn-sm shrink-0 gap-1" title="Run a workflow on this session">
		<WorkflowIcon size={14} />
		<span class="hidden sm:inline">Workflow</span>
	</summary>
	<div
		class="dropdown-content z-20 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 text-sm shadow-lg"
	>
		{#each workflows as w (w.id)}
			<button
				class="btn btn-ghost btn-sm w-full justify-start gap-2"
				disabled={busy}
				onclick={() => start(w.id)}
			>
				<Play size={13} /> {w.name}
			</button>
		{/each}
		{#if err}
			<div class="px-2 py-1 text-xs text-error">{err}</div>
		{/if}
	</div>
</details>
