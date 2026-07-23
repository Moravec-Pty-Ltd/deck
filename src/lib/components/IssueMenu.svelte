<script lang="ts">
	import type { SessionIssue } from '$lib/types';
	import { ISSUE_BADGE } from '$lib/issues';
	import { Ticket } from '@lucide/svelte';
	import Popover from './Popover.svelte';

	// Collapsed ticket chip for sessions with 2+ attached issues (issue #90): a
	// count badge whose dropdown lists each ticket as an open-in-browser link.
	// Display only; the single-issue inline chip stays in +page.svelte.
	let { issues }: { issues: SessionIssue[] } = $props();

	let open = $state(false);

	const summary = $derived(
		issues.map((i) => `${ISSUE_BADGE[i.source].label} ${i.id}`).join(', ')
	);
</script>

<Popover
	bind:open
	summaryClass="badge badge-outline badge-sm header-chip gap-1"
	summaryTitle={summary}
	summaryLabel="{issues.length} linked issues"
	panelClass="p-2 sm:w-max"
>
	{#snippet trigger()}
		<Ticket size={12} />
		{issues.length}
	{/snippet}
	<ul class="menu menu-sm w-full p-0">
		{#each issues as issue (issue.source + ':' + issue.id)}
			<li class={issue.url ? '' : 'menu-disabled'}>
				{#if issue.url}
					<a
						href={issue.url}
						target="_blank"
						rel="noopener noreferrer"
						onclick={() => (open = false)}
					>
						<Ticket size={14} /> {ISSUE_BADGE[issue.source].label} {issue.id}
					</a>
				{:else}
					<span>
						<Ticket size={14} /> {ISSUE_BADGE[issue.source].label} {issue.id}
					</span>
				{/if}
			</li>
		{/each}
	</ul>
</Popover>
