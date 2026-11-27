<script lang="ts">
	import { MonitorSmartphone, RefreshCw } from '@lucide/svelte';
	import { relativeTime } from '$lib/time';

	// The devices signed in to deck (issue #441, S9), each revocable on its own,
	// and the rotate action for deck's token.
	interface Device {
		id: string;
		name: string;
		createdAt: number;
		lastSeenAt?: number;
		current: boolean;
	}

	// "just now", "5m ago", or a date.
	function ago(ts: number): string {
		const t = relativeTime(ts);
		return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
	}

	let devices = $state<Device[]>([]);
	let busy = $state('');
	let note = $state('');

	async function refresh() {
		const res = await fetch('/api/agent/devices').catch(() => null);
		if (res?.ok) devices = ((await res.json()) as { devices: Device[] }).devices;
	}

	$effect(() => {
		void refresh();
	});

	async function act(key: string, url: string, method: string, done: string) {
		if (busy) return;
		busy = key;
		try {
			const res = await fetch(url, { method });
			const reply = await res.json().catch(() => null);
			note = res.ok ? done : (reply?.message ?? 'That did not work; try again.');
			await refresh();
		} catch {
			note = 'Could not reach deck.';
		} finally {
			busy = '';
		}
	}

	function revoke(d: Device) {
		const warn = d.current ? 'This is the device you are using; it will be signed out. Revoke it?' : `Sign out "${d.name}"?`;
		if (confirm(warn)) void act(d.id, `/api/agent/devices/${encodeURIComponent(d.id)}`, 'DELETE', `Signed out ${d.name}.`);
	}

	function rotate() {
		const warn =
			"Make a new deck token? The old one stops working at once, for anything still using it (scripts, apps signed in with it, running agents). Browsers and apps signed in as devices stay signed in; an app signed in with the old token must sign in again. The new token is in ~/.deck/token on the deck machine.";
		if (confirm(warn)) void act('rotate', '/api/agent/token', 'POST', 'deck has a new token. Read it from ~/.deck/token on the deck machine.');
	}
</script>

<div role="status" class="text-xs">{#if note}<p class="mt-0 mb-2 opacity-70">{note}</p>{/if}</div>
{#if devices.length}
	<ul class="m-0 mb-3 list-none space-y-2 p-0">
		{#each devices as d (d.id)}
			<li class="flex flex-wrap items-center gap-3">
				<MonitorSmartphone size={16} class="shrink-0 opacity-60" />
				<div class="min-w-40 flex-1">
					<div class="text-sm">{d.name}{#if d.current}<span class="ml-2 badge badge-sm">This device</span>{/if}</div>
					<div class="text-xs opacity-60">
						Signed in {ago(d.createdAt)}{#if d.lastSeenAt}, last seen {ago(d.lastSeenAt)}{:else}, not used yet{/if}
					</div>
				</div>
				<button class="btn btn-ghost btn-xs" disabled={!!busy} onclick={() => revoke(d)}>Revoke</button>
			</li>
		{/each}
	</ul>
{:else}
	<p class="mt-0 mb-3 text-xs opacity-60">No device has signed in since devices got their own sign-ins.</p>
{/if}
<button class="btn btn-sm" disabled={!!busy} onclick={rotate}><RefreshCw size={15} /> Rotate deck token</button>
