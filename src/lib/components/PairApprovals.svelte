<script lang="ts">
	import { Smartphone, Check, X } from '@lucide/svelte';

	// A live access request from GET /api/agent/pairing: id and code only.
	interface PendingPairing {
		id: string;
		code: string;
	}

	const POLL_MS = 5000;

	// Settings passes a line to show when nothing is waiting; the home page shows nothing.
	let { empty = '' }: { empty?: string } = $props();

	// Approval prompts for devices requesting access (issue #150, phase 2). A
	// person confirms the code shown matches the device in front of them, then
	// approves or denies. Polls the agent pairing route on its own rather than
	// riding the home page's session poll, so it works wherever it is mounted.
	let pending = $state<PendingPairing[]>([]);
	let busy = $state<string | null>(null);

	async function refresh() {
		try {
			const res = await fetch('/api/agent/pairing');
			if (res.ok) pending = ((await res.json()) as { pending: PendingPairing[] }).pending;
		} catch {
			// offline: keep the last list until the next poll
		}
	}

	$effect(() => {
		void refresh();
		const interval = setInterval(refresh, POLL_MS);
		return () => clearInterval(interval);
	});

	async function decide(id: string, approve: boolean) {
		if (busy) return;
		busy = id;
		try {
			await fetch(`/api/agent/pairing/${encodeURIComponent(id)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ approve })
			});
			await refresh();
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
						disabled={busy !== null}
					>
						<Check size={15} /> Approve
					</button>
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => decide(req.id, false)}
						disabled={busy !== null}
					>
						<X size={15} /> Deny
					</button>
				</div>
			</div>
		{/each}
	</div>
{:else if empty}
	<p class="m-0 text-xs opacity-60">{empty}</p>
{/if}
