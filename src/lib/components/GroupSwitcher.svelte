<script lang="ts">
	import { groupSwitch } from '$lib/group-switch.svelte';
	import Popover from './Popover.svelte';
	import { ChevronDown, Layers } from '@lucide/svelte';

	// `panelClass` sizes the menu for where it sits: the sidebar clips anything wider.
	let { panelClass = 'sm:w-64' }: { panelClass?: string } = $props();

	let open = $state(false);
	const label = $derived(groupSwitch.selected ?? 'All');

	function pick(name: string | null) {
		groupSwitch.pick(name);
		open = false;
	}
</script>

<!-- Absent until a project has a group: there is nothing to switch between. -->
{#if groupSwitch.entries.length > 0}
	<Popover
		bind:open
		summaryClass="btn btn-ghost btn-sm max-w-48 flex-nowrap gap-1.5 px-2"
		summaryLabel="Group: {label}{groupSwitch.waitingElsewhere ? ', another group has something waiting' : ''}"
		summaryTitle="Switch group"
		panelClass="p-1 {panelClass}"
	>
		{#snippet trigger()}
			<Layers size={14} class="shrink-0 opacity-60" />
			<span class="truncate font-semibold">{label}</span>
			{#if groupSwitch.waitingElsewhere}
				<span class="size-1.5 shrink-0 rounded-full bg-primary" title="Another group has something waiting"></span>
			{/if}
			<ChevronDown size={13} class="shrink-0 opacity-60" />
		{/snippet}
		<ul class="w-full">
			{#each groupSwitch.entries as entry, i (entry.name ?? '')}
				<li>
					<button
						class="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left hover:bg-base-200 {entry.name ===
						groupSwitch.selected
							? 'bg-primary/10 font-medium text-primary'
							: ''}"
						aria-current={entry.name === groupSwitch.selected ? 'true' : undefined}
						aria-label={entry.count > 0 ? `${entry.label}, ${entry.count} waiting` : entry.label}
						onclick={() => pick(entry.name)}
					>
						<span class="min-w-0 flex-1 truncate">{entry.label}</span>
						{#if entry.count > 0}
							<span class="badge badge-primary badge-sm shrink-0">{entry.count}</span>
						{/if}
						{#if i < 9}
							<kbd class="shrink-0 text-xs opacity-50 max-sm:hidden">⌘{i + 1}</kbd>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	</Popover>
{/if}
