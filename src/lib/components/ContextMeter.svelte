<script lang="ts">
	// How full the session's context window is, pinned with the session total
	// above the composer so it stays in view whatever the scroll. Doubles as the
	// place to compact from: the moment you notice the window is filling is the
	// moment you want to do something about it.
	import { contextPercent, formatContext, type ContextUsage } from '$lib/context-core';

	interface Props {
		id: string;
		context: ContextUsage;
		// A compaction is a turn of its own, so it has to wait for the running one.
		running: boolean;
		compactable: boolean;
	}
	let { id, context, running, compactable }: Props = $props();

	const percent = $derived(contextPercent(context));
	// Amber from two thirds, red once claude's own auto-compaction is close
	// enough that deck's is the last chance to compact on your own terms.
	const tone = $derived(percent >= 85 ? 'bg-error' : percent >= 66 ? 'bg-warning' : 'bg-primary');

	let compacting = $state(false);
	let errorMsg = $state('');

	async function compact() {
		compacting = true;
		errorMsg = '';
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/compact`, { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				errorMsg = body?.message ?? 'compact failed';
			}
		} catch {
			errorMsg = 'compact failed';
		} finally {
			compacting = false;
		}
	}
</script>

<span class="flex shrink-0 items-center gap-1.5" title="Context: {formatContext(context)}">
	<span class="h-1.5 w-12 overflow-hidden rounded-full bg-base-300" aria-hidden="true">
		<span class="block h-full {tone}" style="width: {percent}%"></span>
	</span>
	<span class="tabular-nums" aria-label="Context {percent}% full, {formatContext(context)}">{percent}%</span>
	{#if compactable}
		<button
			class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5"
			onclick={compact}
			disabled={compacting || running}
			title={running ? 'Finishes after the running turn' : 'Summarise the history and free the window'}
		>
			{compacting ? 'Compacting…' : 'Compact'}
		</button>
	{/if}
	{#if errorMsg}
		<span class="text-error">{errorMsg}</span>
	{/if}
</span>
