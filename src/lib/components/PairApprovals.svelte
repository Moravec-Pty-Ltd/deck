<script module lang="ts">
	// Shape of a live access request, mirrored from /api/pair/pending (SvelteKit
	// won't let a client import a $lib/server type). In the module script so the home
	// page can import it alongside the component.
	export interface PendingPairing {
		id: string;
		code: string;
	}
</script>

<script lang="ts">
	import { Smartphone, Check, X } from '@lucide/svelte';

	// Approval prompts for devices requesting access (issue #150, phase 2). The home
	// page reads /api/pair/pending on its poll and hands the live requests here; a
	// person confirms the code shown matches the device in front of them, then
	// approves or denies. On either action we ask the page to refresh the list.
	let { pending, onchange }: { pending: PendingPairing[]; onchange: () => void } = $props();

	let busy = $state<string | null>(null);

	async function decide(id: string, approve: boolean) {
		if (busy) return;
		busy = id;
		try {
			await fetch('/api/pair/approve', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id, approve })
			});
			onchange();
		} finally {
			busy = null;
		}
	}
</script>

{#if pending.length}
	<div class="mb-4 space-y-2">
		{#each pending as req (req.id)}
			<div
				class="flex flex-wrap items-center gap-3 rounded-box border border-primary/40 bg-primary/5 p-3"
				role="alert"
			>
				<Smartphone size={18} class="shrink-0 text-primary" />
				<div class="min-w-0 flex-1">
					<div class="text-sm font-medium">A device wants to access deck</div>
					<div class="text-xs opacity-60">
						Approve only if this code shows on that device:
						<span class="font-mono tracking-widest">{req.code}</span>
					</div>
				</div>
				<div class="flex items-center gap-2">
					<button
						class="btn btn-sm btn-primary"
						onclick={() => decide(req.id, true)}
						disabled={busy === req.id}
					>
						<Check size={15} /> Approve
					</button>
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => decide(req.id, false)}
						disabled={busy === req.id}
					>
						<X size={15} /> Deny
					</button>
				</div>
			</div>
		{/each}
	</div>
{/if}
