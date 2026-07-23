<script lang="ts">
	import type { DeckEffort } from '$lib/types';
	import { EFFORT_LEVELS, effortLabel, switchEffort } from '$lib/effort';
	import { menuAction } from '$lib/menu-action.svelte';
	import { Gauge, Check } from '@lucide/svelte';
	import Popover from './Popover.svelte';

	// Header chip showing a claude session's reasoning effort, opening a switcher
	// (issue #178). Sits beside ModelMenu and mirrors it, minus the expensive-model
	// gate (the effort levels carry no cost warning). Disabled while a turn runs
	// (the effort applies on the next turn, so switching mid-turn would only
	// mislead); the server 409s on that race anyway.
	let {
		id,
		effort,
		disabled = false,
		onChange
	}: {
		id: string;
		effort: DeckEffort | undefined;
		disabled?: boolean;
		onChange: () => void;
	} = $props();

	let open = $state(false);
	const act = menuAction();

	// Clear a stale error on close.
	$effect(() => {
		if (!open) act.clearErr();
	});

	function apply(next: string) {
		void act.run(
			() => switchEffort(id, next),
			() => {
				open = false;
				onChange();
			},
			'effort switch failed'
		);
	}
</script>

{#if disabled}
	<span class="badge badge-outline badge-sm header-chip shrink-0 gap-1 opacity-50" title="Effort switches apply between turns">
		<Gauge size={12} />
		<span class="hidden sm:inline">{effortLabel(effort)}</span>
	</span>
{:else}
	<Popover
		bind:open
		summaryClass="badge badge-outline badge-sm header-chip gap-1"
		summaryTitle="Effort: {effortLabel(effort)} (click to change)"
		panelClass="p-2 sm:w-48"
	>
		{#snippet trigger()}
			<Gauge size={12} />
			<span class="hidden sm:inline">{effortLabel(effort)}</span>
		{/snippet}
		<ul class="menu menu-sm w-full p-0">
			{#each ['', ...EFFORT_LEVELS] as e (e)}
				<li>
					<button onclick={() => apply(e)} disabled={act.busy}>
						{effortLabel(e)}
						{#if (effort ?? '') === e}<Check size={14} class="ml-auto" />{/if}
					</button>
				</li>
			{/each}
		</ul>
		{#if act.err}<p class="mt-1 px-1 text-xs text-error">{act.err}</p>{/if}
	</Popover>
{/if}
