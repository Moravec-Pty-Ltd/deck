<script lang="ts">
	// What a session is waiting on, after the last chat bubble: its active watches
	// and running subagents, newest first. Three show; "N more" expands the rest,
	// and expanding also shows each watch's check command.
	import { ChevronDown, ChevronUp, CircleCheck, CircleX, Play, Timer, X } from '@lucide/svelte';
	import { agentDelete, agentPost } from '$lib/agent-api';
	import { activityEntries, formatCountdown, visibleEntries } from '$lib/activity-core';
	import { formatDuration, type AgentState } from '$lib/subagents-core';
	import type { Watch } from '$lib/watches';

	let {
		watches,
		agents,
		elapsed,
		onjump,
		turnRunning
	}: {
		watches: Watch[];
		agents: AgentState[];
		elapsed: (agent: AgentState) => number;
		onjump: (agent: AgentState) => void;
		turnRunning: boolean;
	} = $props();

	let expanded = $state(false);
	// Cancelled here, hidden before the feed catches up.
	let cancelled = $state<string[]>([]);
	let now = $state(Date.now());

	const live = $derived(watches.filter((w) => !cancelled.includes(w.id)));
	const entries = $derived(activityEntries(live, agents, (a) => Date.now() - elapsed(a)));
	const view = $derived(visibleEntries(entries, expanded));

	$effect(() => {
		if (!live.length) return;
		now = Date.now();
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	async function cancel(id: string) {
		cancelled.push(id);
		try {
			await agentDelete(`/api/agent/watches/${encodeURIComponent(id)}`);
		} catch {
			cancelled = cancelled.filter((c) => c !== id);
		}
	}

	// The feed brings the new due time; a watch already gone has nothing to undo.
	function runNow(id: string) {
		void agentPost(`/api/agent/watches/${encodeURIComponent(id)}/run`).catch(() => {});
	}
</script>

{#if entries.length}
	<ul class="mx-2 space-y-0.5 rounded-box border border-base-300 py-1 text-xs" aria-label="Session activity">
		{#each view.shown as e (e.key)}
			<li>
				{#if e.kind === 'watch'}
					<div class="flex items-center gap-2 px-3 py-1">
						<Timer size={14} class="shrink-0 opacity-60" />
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{e.watch.title}</span>
							{#if expanded && e.watch.command}
								<code class="block truncate opacity-60">{e.watch.command}</code>
							{/if}
						</span>
						<span class="shrink-0 tabular-nums opacity-60">
							{e.watch.dueAt <= now && turnRunning ? 'runs after this turn' : formatCountdown(e.watch.dueAt - now)}
						</span>
						{#if e.watch.dueAt > now}
							<button
								type="button"
								class="btn btn-ghost btn-xs btn-square"
								aria-label="Run watch now"
								onclick={() => runNow(e.watch.id)}
							>
								<Play size={14} />
							</button>
						{/if}
						<button
							type="button"
							class="btn btn-ghost btn-xs btn-square"
							aria-label="Cancel watch"
							onclick={() => void cancel(e.watch.id)}
						>
							<X size={14} />
						</button>
					</div>
				{:else}
					{@const a = e.agent}
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
							{#if a.description && a.subagentType}
								<span class="opacity-50"> ({a.subagentType})</span>
							{/if}
							{#if a.status === 'running' && a.activity}
								<span class="opacity-50"> · {a.activity}</span>
							{/if}
						</span>
						<span class="shrink-0 tabular-nums opacity-50">{formatDuration(elapsed(a))}</span>
					</button>
				{/if}
			</li>
		{/each}
		{#if view.more}
			<li>
				<button
					type="button"
					class="flex w-full cursor-pointer items-center gap-1 px-3 py-1 text-left opacity-70 hover:bg-base-200"
					onclick={() => (expanded = true)}
				>
					<ChevronDown size={14} />{view.more} more
				</button>
			</li>
		{:else if expanded}
			<li>
				<button
					type="button"
					class="flex w-full cursor-pointer items-center gap-1 px-3 py-1 text-left opacity-70 hover:bg-base-200"
					onclick={() => (expanded = false)}
				>
					<ChevronUp size={14} />Show less
				</button>
			</li>
		{/if}
	</ul>
{/if}
