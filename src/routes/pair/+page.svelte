<script lang="ts">
	import { ShieldCheck } from '@lucide/svelte';

	// Request-access flow for a new device that doesn't have the token. It asks the
	// server for a short code, shows it, and polls until an already-signed-in browser
	// approves - at which point the status endpoint has set our cookie and we're in.
	// The raw token is never shown to this device.
	type Phase = 'idle' | 'waiting' | 'approved' | 'denied' | 'expired' | 'error';

	let phase = $state<Phase>('idle');
	let code = $state('');
	let secret = $state('');
	let busy = $state(false);
	let message = $state('');

	async function request() {
		if (busy) return;
		busy = true;
		message = '';
		try {
			const res = await fetch('/api/pair/request', { method: 'POST' });
			if (!res.ok) throw new Error('could not start pairing');
			const data = await res.json();
			code = data.code;
			secret = data.secret;
			phase = 'waiting';
		} catch (e) {
			phase = 'error';
			message = e instanceof Error ? e.message : 'something went wrong';
		} finally {
			busy = false;
		}
	}

	async function poll() {
		try {
			const res = await fetch(`/api/pair/status?secret=${encodeURIComponent(secret)}`);
			if (!res.ok) return;
			const { status } = await res.json();
			if (status === 'approved') {
				phase = 'approved';
				// The cookie is set on the status response; land on the home page authed.
				location.href = '/';
			} else if (status === 'denied') {
				phase = 'denied';
			} else if (status === 'expired' || status === 'unknown') {
				phase = 'expired';
			}
		} catch {
			// Transient network error; keep polling.
		}
	}

	// Poll only while waiting; stop the moment we leave that phase or unmount.
	$effect(() => {
		if (phase !== 'waiting') return;
		const interval = setInterval(poll, 2000);
		return () => clearInterval(interval);
	});
</script>

<div class="mx-auto mt-24 max-w-sm">
	<div class="rounded-box border border-base-300 bg-base-100 p-6">
		<h1 class="mb-1 text-xl font-semibold">Request access</h1>

		{#if phase === 'idle'}
			<p class="mb-4 text-sm opacity-70">
				Ask a device that's already signed in to approve this one. No token needed.
			</p>
			<button class="btn w-full btn-primary" onclick={request} disabled={busy}>
				{#if busy}<span class="loading loading-spinner loading-sm"></span>{/if}
				Request access
			</button>
		{:else if phase === 'waiting'}
			<p class="mb-4 text-sm opacity-70">
				On a device that's already signed in, approve this request. Check the code matches.
			</p>
			<div class="rounded-box bg-base-200 py-6 text-center">
				<div class="font-mono text-4xl font-semibold tracking-[0.3em]">{code}</div>
			</div>
			<p class="mt-4 flex items-center justify-center gap-2 text-sm opacity-60">
				<span class="loading loading-spinner loading-xs"></span>
				Waiting for approval...
			</p>
		{:else if phase === 'approved'}
			<p class="flex items-center gap-2 text-sm text-success">
				<ShieldCheck size={16} /> Approved. Signing you in...
			</p>
		{:else}
			<p class="mb-4 text-sm opacity-70">
				{#if phase === 'denied'}
					The request was denied.
				{:else if phase === 'expired'}
					The request expired.
				{:else}
					{message}
				{/if}
			</p>
			<button class="btn w-full btn-primary" onclick={request} disabled={busy}>Try again</button>
		{/if}

		<a href="/login" class="mt-4 block text-center text-sm opacity-60 hover:opacity-100"
			>Have the token? Sign in</a
		>
	</div>
</div>
