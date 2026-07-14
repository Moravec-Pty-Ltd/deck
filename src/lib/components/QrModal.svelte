<script lang="ts">
	import { encode } from 'uqr';
	import { X, TriangleAlert } from '@lucide/svelte';

	// Sign-in QR for onboarding a new device. It encodes `${origin}/?token=<token>`
	// - the same access URL the server prints at startup - so scanning it on a device
	// on the same network hits the ?token= gate and gets signed in, no manual paste.
	// The token is fetched from the authed /api/token (the deck_token cookie is
	// httpOnly, so client JS can't read it directly).
	let { open = $bindable(false) }: { open?: boolean } = $props();

	let token = $state('');
	let error = $state('');

	// Fetch the token whenever the modal opens (and re-fetch if it's reopened after a
	// failure). window.location.origin is the origin this browser actually reached
	// deck at, so the encoded host is reachable from the scanning device (baseUrl
	// defaults to localhost, which wouldn't be).
	$effect(() => {
		if (!open) return;
		error = '';
		fetch('/api/token')
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error('could not load token'))))
			.then((d) => (token = d.token))
			.catch((e) => (error = e.message));
	});

	const url = $derived(token ? `${location.origin}/?token=${token}` : '');

	// A single <path> built from the module matrix, drawn black on a white tile
	// (fixed colours, not theme tokens: QR scanners want dark-on-light contrast) with
	// a quiet zone so the code stays scannable.
	const BORDER = 4;
	const qr = $derived.by(() => {
		if (!url) return null;
		try {
			const { data, size } = encode(url, { ecc: 'M' });
			let d = '';
			for (let y = 0; y < size; y++)
				for (let x = 0; x < size; x++) if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
			return { d, size };
		} catch {
			return null;
		}
	});

	function close() {
		open = false;
	}
</script>

{#if open}
	<div class="modal modal-open modal-bottom sm:modal-middle" role="dialog">
		<div class="modal-box max-w-sm">
			<div class="mb-3 flex items-center justify-between">
				<h3 class="text-lg font-semibold">Sign in another device</h3>
				<button class="btn btn-square btn-ghost btn-sm" onclick={close} aria-label="Close">
					<X size={16} />
				</button>
			</div>

			{#if error}
				<p class="text-sm text-error">{error}</p>
			{:else if qr}
				<div class="flex justify-center">
					<svg
						class="h-56 w-56 rounded-box"
						viewBox={`${-BORDER} ${-BORDER} ${qr.size + BORDER * 2} ${qr.size + BORDER * 2}`}
						shape-rendering="crispEdges"
						role="img"
						aria-label="Sign-in QR code"
					>
						<rect
							x={-BORDER}
							y={-BORDER}
							width={qr.size + BORDER * 2}
							height={qr.size + BORDER * 2}
							fill="#fff"
						/>
						<path d={qr.d} fill="#000" />
					</svg>
				</div>
				<p class="mt-3 text-center text-sm opacity-70">
					Scan with a device on the same network to sign it in.
				</p>
				<div class="mt-3 flex items-start gap-2 rounded-box bg-warning/10 p-3 text-xs text-warning">
					<TriangleAlert size={15} class="mt-0.5 shrink-0" />
					<span>
						This grants full, long-lived access to deck. Only show it to devices and people you
						trust.
					</span>
				</div>
			{:else}
				<p class="p-8 text-center text-sm opacity-60">Loading...</p>
			{/if}
		</div>
		<button class="modal-backdrop" onclick={close} aria-label="Close"></button>
	</div>
{/if}
