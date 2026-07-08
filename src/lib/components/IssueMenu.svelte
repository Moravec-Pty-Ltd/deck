<script lang="ts">
	import type { SessionIssue } from '$lib/types';
	import { ISSUE_BADGE } from '$lib/issues';
	import { dismissOnOutside, keepInView } from '$lib/dismiss';
	import { Ticket } from '@lucide/svelte';

	// Collapsed ticket chip for sessions with 2+ attached issues (issue #90): a
	// count badge whose dropdown lists each ticket as an open-in-browser link.
	// Display only; the single-issue inline chip stays in +page.svelte.
	let { issues }: { issues: SessionIssue[] } = $props();

	let open = $state(false);

	const summary = $derived(
		issues.map((i) => `${ISSUE_BADGE[i.source].label} ${i.id}`).join(', ')
	);
</script>

<details class="dropdown dropdown-end shrink-0" bind:open use:dismissOnOutside={() => (open = false)}>
	<summary
		class="badge badge-outline badge-sm cursor-pointer list-none gap-1 [&::-webkit-details-marker]:hidden"
		title={summary}
		aria-label="{issues.length} linked issues"
	>
		<Ticket size={12} />
		{issues.length}
	</summary>

	<ul
		class="menu dropdown-content menu-sm z-20 mt-1 w-max rounded-box border border-base-300 bg-base-100 p-2 text-sm shadow-lg"
		use:keepInView
	>
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
</details>
