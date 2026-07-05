<script lang="ts">
	import type { WorkflowRun } from '$lib/types';
	import { Check, CircleAlert, CircleHelp, Loader2, X } from '@lucide/svelte';

	// Progress strip for the workflow run attached to a session (issue #111):
	// one chip per step, the run's status, and a cancel/dismiss action. `run`
	// comes from the /api/sessions poll (see the session page's liveStatus
	// pattern), so it lags a transition by at most one poll.
	let { run, sessionId, onChange }: { run: WorkflowRun; sessionId: string; onChange: () => void } =
		$props();

	let busy = $state(false);

	const active = $derived(run.status === 'running' || run.status === 'awaiting-input');

	function stepState(i: number): 'done' | 'current' | 'pending' {
		if (i < run.step || run.status === 'done') return 'done';
		return i === run.step ? 'current' : 'pending';
	}

	// Cancel an active run; the same action clears a terminal one from the strip.
	async function cancel() {
		if (busy) return;
		if (active && !confirm(`Cancel the "${run.name}" run?`)) return;
		busy = true;
		try {
			await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/workflow`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'cancel' })
			});
			onChange();
		} finally {
			busy = false;
		}
	}
</script>

<div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-box border border-base-300 bg-base-100 px-2 py-1.5 text-xs">
	<span class="font-medium">{run.name}</span>
	{#if run.status === 'running'}
		<Loader2 size={13} class="animate-spin text-primary" />
	{:else if run.status === 'awaiting-input'}
		<span class="flex items-center gap-1 text-primary"><CircleHelp size={13} /> waiting for you</span>
	{:else if run.status === 'paused'}
		<span class="flex items-center gap-1 text-warning"><CircleAlert size={13} /> paused</span>
	{:else if run.status === 'done'}
		<span class="flex items-center gap-1 text-success"><Check size={13} /> done</span>
	{:else}
		<span class="opacity-60">cancelled</span>
	{/if}

	<div class="flex flex-wrap items-center gap-1">
		{#each run.steps as step, i (i)}
			{@const state = stepState(i)}
			<span
				class="badge badge-sm gap-1 {state === 'done'
					? 'badge-success badge-outline'
					: state === 'current'
						? run.status === 'paused' || run.status === 'cancelled'
							? 'badge-warning'
							: 'badge-primary'
						: 'badge-ghost opacity-60'}"
				title="{step.type}: {step.name}"
			>
				{#if state === 'done'}<Check size={11} />{/if}
				{step.name}
			</span>
		{/each}
	</div>

	{#if run.status === 'paused' && run.reason}
		<span class="min-w-0 flex-1 truncate text-warning" title={run.reason}>{run.reason}</span>
	{:else}
		<div class="flex-1"></div>
	{/if}

	<button
		class="btn btn-ghost btn-xs shrink-0 gap-1"
		onclick={cancel}
		disabled={busy}
		aria-label={active ? 'Cancel workflow run' : 'Dismiss workflow run'}
	>
		<X size={12} /> {active ? 'cancel' : 'dismiss'}
	</button>
</div>
