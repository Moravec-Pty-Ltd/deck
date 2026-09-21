<script lang="ts">
	import { AGENT_KINDS, type SessionKind } from '$lib/types';
	import { ArrowLeftRight, Check, RotateCw } from '@lucide/svelte';
	import { restartSession } from '$lib/session-restart';
	import Popover from './Popover.svelte';
	import { menuAction } from '$lib/menu-action.svelte';

	let { id, kind, disabled = false, onChange }: {
		id: string;
		kind: SessionKind;
		disabled?: boolean;
		onChange: () => void;
	} = $props();
	let open = $state(false);
	const act = menuAction();
	$effect(() => {
		if (disabled) open = false;
		if (!open) act.clearErr();
	});

	function switchTo(next: string) {
		if (disabled || act.busy) return;
		void act.run(async () => {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/agent`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: next })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message ?? 'agent switch failed');
			}
		}, () => { open = false; onChange(); }, 'agent switch failed');
	}

	// Restart the claude process in place (see server/session-restart.ts). Lives
	// here rather than as another header control.
	function restart() {
		if (disabled || act.busy) return;
		void act.run(() => restartSession(id), () => { open = false; onChange(); }, 'restart failed');
	}
</script>

{#if disabled}
	<span class="badge badge-outline badge-sm header-chip gap-1 opacity-50" title="Agent switches apply between turns">
		<ArrowLeftRight size={12} /> {kind}
	</span>
{:else}
	<Popover bind:open direction="top" summaryClass="badge badge-outline badge-sm header-chip gap-1" summaryTitle="Agent · restart" panelClass="p-2 sm:w-64">
		{#snippet trigger()}<ArrowLeftRight size={12} /> {kind}{/snippet}
		<p class="px-2 py-1 text-xs opacity-70">Continue with another agent. Recent conversation text is handed off with your next message. Older context, tool output, and images may be omitted. Model settings reset.</p>
		<ul class="menu menu-sm w-full p-0">
			{#each AGENT_KINDS as agent}
				<li><button onclick={() => switchTo(agent)} disabled={act.busy}>
					{agent}{#if kind === agent}<Check size={14} class="ml-auto" />{/if}
				</button></li>
			{/each}
			{#if kind === 'claude'}
				<li><div class="divider my-1"></div></li>
				<li><button onclick={restart} disabled={act.busy} title="Reload changed CLAUDE.md, settings, skills, or MCP config. The conversation continues.">
					<RotateCw size={14} /> Restart claude
				</button></li>
			{/if}
		</ul>
		{#if act.err}<p class="mt-1 px-2 text-xs text-error">{act.err}</p>{/if}
	</Popover>
{/if}
