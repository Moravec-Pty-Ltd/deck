<script lang="ts">
	// Running subagents, pinned above the composer: how many, and for each what it
	// is doing, for how long, and how far it has got. Collapsed to one line;
	// tapping an agent jumps to its card in the transcript. Agents that just
	// finished linger for a moment with their outcome before dropping off.
	import { ChevronDown, CircleCheck, CircleX } from '@lucide/svelte';
	import { formatDuration, type AgentState } from '$lib/subagents-core';

	let {
		agents,
		elapsed,
		onjump
	}: {
		agents: AgentState[];
		elapsed: (agent: AgentState) => number;
		onjump: (agent: AgentState) => void;
	} = $props();

	let open = $state(false);
	const running = $derived(agents.filter((a) => a.status === 'running'));
</script>

{#if agents.length}
	<div class="-mx-2 border-t border-base-300 text-xs">
		<button
			type="button"
			class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-base-200"
			onclick={() => (open = !open)}
			aria-expanded={open}
		>
			{#if running.length}
				<span class="loading loading-spinner loading-xs shrink-0 text-info"></span>
				<span class="shrink-0 font-medium">
					{running.length} {running.length === 1 ? 'agent' : 'agents'} running
				</span>
			{:else}
				<CircleCheck size={14} class="shrink-0 text-success" />
				<span class="shrink-0 font-medium">agents finished</span>
			{/if}
			<span class="flex-1"></span>
			<ChevronDown size={14} class="shrink-0 opacity-60 transition-transform {open ? 'rotate-180' : ''}" />
		</button>
		{#if open}
			<ul class="max-h-48 overflow-y-auto pb-1">
				{#each agents as a (a.taskId)}
					<li>
						<button
							type="button"
							class="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left hover:bg-base-200"
							onclick={() => onjump(a)}
						>
							{#if a.status === 'running'}
								<span class="loading loading-spinner loading-xs shrink-0 text-info"></span>
							{:else if a.status === 'completed'}
								<CircleCheck size={14} class="shrink-0 text-success" />
							{:else}
								<CircleX size={14} class="shrink-0 {a.status === 'failed' ? 'text-error' : 'text-warning'}" />
							{/if}
							<span class="min-w-0 flex-1 truncate">
								<span class="font-medium">{a.description || a.subagentType}</span>
								{#if a.status === 'running' && a.activity}
									<span class="opacity-50"> · {a.activity}</span>
								{/if}
							</span>
							<span class="shrink-0 tabular-nums opacity-50">{formatDuration(elapsed(a))}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
