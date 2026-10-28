<script lang="ts">
	// A session row's issue reference (`#315`, `ENG-123`), linking to the issue.
	// Sits beside the row's link rather than inside it: a link can't nest in one.
	import type { SessionIssue } from '$lib/types';
	import { shortIssueId } from '$lib/issues';

	let { issues, class: cls = '' }: { issues: SessionIssue[]; class?: string } = $props();
	const first = $derived(issues[0]);
	const label = $derived(
		first ? shortIssueId(first.source, first.id) + (issues.length > 1 ? ` +${issues.length - 1}` : '') : ''
	);
	const full = $derived(issues.map((i) => (i.title ? `${i.id}: ${i.title}` : i.id)).join('\n'));
</script>

{#if first}
	{#if first.url}
		<a
			href={first.url}
			target="_blank"
			rel="noopener noreferrer"
			class="badge badge-outline badge-xs link-hover shrink-0 font-mono opacity-70 {cls}"
			title={full}>{label}</a
		>
	{:else}
		<span class="badge badge-outline badge-xs shrink-0 font-mono opacity-70 {cls}" title={full}>{label}</span>
	{/if}
{/if}
