<script lang="ts">
	// Running subagents, pinned above the composer: how many, and for each what it
	// is doing, for how long, and how far it has got. Collapsed to one line;
	// tapping an agent jumps to its card in the transcript. Agents that just
	// finished linger for a moment with their outcome before dropping off.
	import { Bot, ChevronDown, CircleCheck, CircleX } from '@lucide/svelte';
	import { formatDuration, type AgentState } from '$lib/subagents-core';
	import { formatTokens } from '$lib/context-core';

	let {
		agents,
		seenAt,
		onjump
	}: {
		agents: AgentState[];
		// When each agent's figures last changed, by task id, so elapsed time keeps
		// counting between progress reports.
		seenAt: Record<string, number>;
		onjump: (agent: AgentState) => void;
	} = $props();

	let open = $state(false);
	let now = $state(Date.now());

	$effect(() => {
		if (!agents.length) return;
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	const running = $derived(agents.filter((a) => a.status === 'running'));

	function elapsed(a: AgentState): string {
		if (a.status !== 'running') return formatDuration(a.durationMs);
		const since = seenAt[a.taskId];
		return formatDuration(a.durationMs + (since ? Math.max(0, now - since) : 0));
	}
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
				<span class="loading loading-ring loading-xs shrink-0 text-primary"></span>
				<span class="shrink-0 font-medium">
					{running.length} {running.length === 1 ? 'agent' : 'agents'} running
				</span>
			{:else}
				<CircleCheck size={14} class="shrink-0 text-success" />
				<span class="shrink-0 font-medium">agents finished</span>
			{/if}
			{#if !open}
				<span class="min-w-0 flex-1 truncate opacity-60">
					{agents.map((a) => a.description || a.subagentType).join(' · ')}
				</span>
			{:else}
				<span class="flex-1"></span>
			{/if}
			<ChevronDown size={14} class="shrink-0 opacity-60 transition-transform {open ? 'rotate-180' : ''}" />
		</button>
		{#if open}
			<ul class="max-h-56 overflow-y-auto pb-1">
				{#each agents as a (a.taskId)}
					<li>
						<button
							type="button"
							class="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left hover:bg-base-200"
							onclick={() => onjump(a)}
						>
							{#if a.status === 'completed'}
								<CircleCheck size={14} class="mt-0.5 shrink-0 text-success" />
							{:else if a.status !== 'running'}
								<CircleX size={14} class="mt-0.5 shrink-0 text-error" />
							{:else}
								<Bot size={14} class="mt-0.5 shrink-0 opacity-60" />
							{/if}
							<span class="min-w-0 flex-1">
								<span class="block truncate font-medium">{a.description || a.subagentType}</span>
								<span class="block truncate opacity-60">
									{a.status === 'running' ? a.activity || 'starting…' : a.status === 'completed' ? 'done' : a.status}
								</span>
							</span>
							<span class="shrink-0 text-right tabular-nums opacity-60">
								<span class="block">{elapsed(a)}</span>
								<span class="block">{a.toolUses} steps · {formatTokens(a.tokens)}</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
