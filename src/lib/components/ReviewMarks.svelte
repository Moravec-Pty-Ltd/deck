<script lang="ts">
	import { Check, X } from '@lucide/svelte';
	import { REVIEW_COLOR } from '$lib/pr';

	// The PR review tally: green ticks per approval, red crosses per change-request,
	// each capped then shown as icon + count so a heavily-reviewed PR stays compact.
	// Shared by the header PR chip (PrMenu) and the sidebar session row so both
	// render identical marks. Renders nothing when there are no reviews yet; the
	// caller controls the wrapper's layout/visibility via `class`.
	let {
		approvals = 0,
		changesRequested = 0,
		cap = 5,
		class: klass = 'inline-flex items-center gap-0.5',
		title
	}: {
		approvals?: number;
		changesRequested?: number;
		cap?: number;
		class?: string;
		title?: string;
	} = $props();
</script>

{#snippet marks(count: number, color: string, Icon: typeof Check)}
	{#if count > 0}
		<span class="inline-flex items-center" style="color:{color}">
			{#if count <= cap}
				{#each Array(count) as _, i (i)}<Icon size={11} strokeWidth={3} />{/each}
			{:else}
				<Icon size={11} strokeWidth={3} /><span class="ml-0.5 text-[10px] font-semibold leading-none">{count}</span>
			{/if}
		</span>
	{/if}
{/snippet}

{#if approvals > 0 || changesRequested > 0}
	<span class={klass} {title}>
		{@render marks(approvals, REVIEW_COLOR.approve, Check)}
		{@render marks(changesRequested, REVIEW_COLOR.changes, X)}
	</span>
{/if}
