<script lang="ts">
	import { Smartphone, Check, X } from '@lucide/svelte';

	// A live access request from GET /api/agent/pairing: the id; the code shows only on that device.
	interface PendingPairing {
		id: string;
	}

	const POLL_MS = 5000;

	// Settings passes a line to show when nothing is waiting; the home page shows nothing.
	let { empty = '' }: { empty?: string } = $props();

	// Approval prompts for devices requesting access (issue #150, phase 2). A
	// person types the code the device in front of them shows to approve it, or
	// denies it. Polls the agent pairing route on its own rather than
	// riding the home page's session poll, so it works wherever it is mounted.
	let pending = $state<PendingPairing[]>([]);
	let busy = $state<string | null>(null);
	let codes = $state<Record<string, string>>({});
	let failed = $state('');

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
			const res = await fetch(`/api/agent/pairing/${encodeURIComponent(id)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(approve ? { approve, code: codes[id] ?? '' } : { approve })
			});
			const reply = await res.json().catch(() => null);
			if (!res.ok) failed = reply?.message ?? 'That did not work; try again.';
			else failed = reply?.ok ? '' : 'That request is no longer waiting.';
			await refresh();
		} catch {
			failed = 'Could not reach deck.';
		} finally {
			busy = null;
		}
	}
</script>

<div class="sr-only" role="status">{pending.length ? 'A device wants to access deck' : ''}</div>
<div role="alert">
	{#if failed}<p class="mt-0 mb-2 text-xs text-error">{failed}</p>{/if}
</div>
{#if pending.length}
	<div class="mb-4 space-y-2">
		{#each pending as req (req.id)}
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void decide(req.id, true);
				}}
				class="flex flex-wrap items-center gap-3 rounded-box border border-primary/40 bg-primary/5 p-3"
				aria-label="Sign-in request"
			>
				<Smartphone size={18} class="shrink-0 text-primary" />
				<div class="min-w-48 flex-1">
					<div class="text-sm font-medium">A device wants to access deck</div>
					<div class="text-xs opacity-60">Type the code it shows to approve it.</div>
				</div>
				<div class="flex items-center gap-2">
					<input
						class="input input-sm w-28 font-mono tracking-widest"
						aria-label="Code shown on the device"
						inputmode="numeric"
						autocomplete="off"
						maxlength="7"
						placeholder="Code"
						bind:value={codes[req.id]}
					/>
					<button
						type="submit"
						class="btn btn-sm btn-primary"
						disabled={busy !== null || (codes[req.id] ?? '').replace(/\s/g, '').length !== 6}
					>
						<Check size={15} /> Approve
					</button>
					<button
						type="button"
						class="btn btn-ghost btn-sm"
						onclick={() => decide(req.id, false)}
						disabled={busy !== null}
					>
						<X size={15} /> Deny
					</button>
				</div>
			</form>
		{/each}
	</div>
{:else if empty}
	<p class="m-0 text-xs opacity-60">{empty}</p>
{/if}
