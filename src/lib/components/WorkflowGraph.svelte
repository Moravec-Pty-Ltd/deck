<script lang="ts">
	import type { RunPhaseDigest } from '$lib/workflows';
	import {
		chainOrder,
		graphEdges,
		visitBadge,
		visitLabel,
		DECISION_BADGE,
		PHASE_STATUS_VIEW,
		type GraphEdge
	} from '$lib/workflow-view';
	import { relativeTime } from '$lib/time';
	import { ArrowRight, ArrowUp, Flag, Gavel, Eye, ExternalLink } from '@lucide/svelte';

	// A run's phases as a left-to-right chain with its loop-backs drawn underneath.
	// Read-only for now; `phases` + `current` is the whole contract so an editing
	// mode can be layered onto the same component later.
	interface Props {
		phases: RunPhaseDigest[];
		current: string;
	}
	let { phases, current }: Props = $props();

	let selected = $state<string | null>(null);

	const ordered = $derived(chainOrder(phases));
	const edges = $derived(graphEdges(ordered));
	const open = $derived(ordered.find((p) => p.id === selected));
	const labelOf = (id: string) => phases.find((p) => p.id === id)?.label ?? id;

	function edgeText(e: GraphEdge): string {
		if (e.kind === 'next') return `${labelOf(e.from)} then ${labelOf(e.to)}`;
		return `${labelOf(e.from)} fails, ${e.back ? 'back' : 'on'} to ${labelOf(e.to)}`;
	}

	// The spanned connector runs centre to centre, so inset it by half a column.
	function edgeStyle(e: GraphEdge): string {
		const lo = Math.min(e.fromIndex, e.toIndex);
		const span = Math.abs(e.fromIndex - e.toIndex) + 1;
		const inset = 50 / span;
		return `grid-column: ${lo + 1} / span ${span}; --inset: ${inset}%`;
	}
</script>

<div class="overflow-x-auto pb-1">
	<div class="grid gap-x-5 gap-y-1" style="grid-template-columns: repeat({ordered.length}, minmax(7.5rem, 1fr))">
		{#each ordered as p, i (p.id)}
			{@const view = PHASE_STATUS_VIEW[p.status]}
			{@const badge = visitBadge(p)}
			{@const isCurrent = p.id === current}
			<div class="relative">
				<button
					type="button"
					class="flex h-full w-full flex-col items-start gap-1 rounded-box border bg-base-100 px-2.5 py-2 text-left hover:bg-base-200 {view.node} {isCurrent ? 'border-2' : ''} {selected === p.id ? 'bg-base-200' : ''}"
					onclick={() => (selected = selected === p.id ? null : p.id)}
					aria-expanded={selected === p.id}
					aria-current={isCurrent ? 'step' : undefined}
				>
					<span class="flex w-full items-center gap-1.5">
						{#if isCurrent}
							<span class="phase-pulse inline-block size-2 shrink-0 rounded-full bg-primary" title="Current phase"></span>
						{/if}
						<span class="truncate text-sm font-medium">{p.label}</span>
					</span>
					<span class="flex w-full flex-wrap items-center gap-1 text-xs">
						<span class="opacity-60">{view.label}</span>
						{#if badge}
							<span class="badge badge-xs badge-ghost font-mono" title="Visits{p.cap ? ' against the cap' : ''}">{badge}</span>
						{/if}
						{#if p.decisions.length}
							<span class="badge badge-xs badge-ghost gap-0.5" title="{p.decisions.length} decisions">
								<Gavel size={10} />{p.decisions.length}
							</span>
						{/if}
					</span>
				</button>
				{#if ordered[i + 1]?.id === p.next}
					<ArrowRight size={12} class="absolute top-1/2 -right-4 -translate-y-1/2 opacity-40" aria-hidden="true" />
				{:else if p.next === 'done'}
					<span class="absolute top-1/2 -right-4 -translate-y-1/2 opacity-40" title="Then done">
						<Flag size={12} />
					</span>
				{/if}
			</div>
		{/each}
		{#each edges as e (`${e.from}-${e.to}-${e.kind}`)}
			<div class="mt-1" style={edgeStyle(e)}>
				<div
					class="relative mx-[var(--inset)] h-3 rounded-b-md border-x border-b {e.kind === 'fail' ? 'border-dashed border-error/60' : 'border-base-content/30'}"
				>
					<ArrowUp
						size={12}
						class="absolute -top-2 {e.toIndex < e.fromIndex ? '-left-[6.5px]' : '-right-[6.5px]'} {e.kind === 'fail' ? 'text-error/80' : 'opacity-50'}"
						aria-hidden="true"
					/>
				</div>
				<div class="mt-0.5 truncate text-center text-[11px] opacity-60">{edgeText(e)}</div>
			</div>
		{/each}
	</div>
</div>

{#if open}
	<div class="mt-3 rounded-box border border-base-300 bg-base-100 p-3">
		<div class="mb-2 flex items-center gap-2">
			<span class="text-sm font-semibold">{open.label}</span>
			<span class="text-xs opacity-60">{open.role} · {PHASE_STATUS_VIEW[open.status].label}</span>
		</div>
		{#if open.sessions.length}
			<ul class="space-y-1">
				{#each open.sessions as s (s.visit)}
					<li class="flex flex-wrap items-baseline gap-2 text-sm">
						{#if s.sessionId}
							<a class="link link-hover inline-flex items-center gap-1 font-medium" href="/s/{encodeURIComponent(s.sessionId)}">
								{visitLabel(open, s.visit)}<ExternalLink size={11} class="opacity-50" />
							</a>
						{:else}
							<span class="font-medium">{visitLabel(open, s.visit)}</span>
						{/if}
						<span class="badge badge-xs {s.result === 'pass' ? 'badge-success' : s.result ? 'badge-error badge-outline' : 'badge-ghost'}">
							{s.result ?? 'running'}
						</span>
						{#if s.humanTouched}<span class="badge badge-xs badge-warning badge-outline">hand edited</span>{/if}
						{#if s.detail}<span class="min-w-0 flex-1 text-xs opacity-70">{s.detail}</span>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-xs opacity-50">Not run yet.</p>
		{/if}
		{#if open.decisions.length}
			<div class="mt-3 mb-1 text-xs font-medium opacity-70">Decisions</div>
			<ul class="space-y-1.5">
				{#each open.decisions as d, i (i)}
					<li class="rounded-box px-2 py-1.5 text-sm {d.by === 'overseer' ? 'border border-secondary bg-secondary/10' : ''}">
						<div class="flex items-center gap-2">
							<span class="badge badge-xs gap-1 {DECISION_BADGE[d.by]}">
								{#if d.by === 'overseer'}<Eye size={10} />{/if}{d.by}
							</span>
							<span class="font-medium">{d.action}</span>
							<span class="ml-auto text-xs opacity-50">{relativeTime(d.at)}</span>
						</div>
						{#if d.reason && d.reason !== d.action}
							<p class="mt-0.5 text-xs {d.by === 'overseer' ? '' : 'opacity-70'}">{d.reason}</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
