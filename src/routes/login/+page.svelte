<script lang="ts">
	import { onMount } from 'svelte';

	let { form }: { form?: { wrong?: boolean } | null } = $props();
	let token = $state('');
	let formEl: HTMLFormElement | undefined = $state();

	// The sign-in QR opens /login#token=...: the fragment never reaches the server,
	// so the credential is posted from here and then dropped from the address bar.
	onMount(() => {
		const fromQr = new URLSearchParams(location.hash.slice(1)).get('token');
		if (!fromQr) return;
		history.replaceState(null, '', location.pathname);
		token = fromQr;
		queueMicrotask(() => formEl?.requestSubmit());
	});
</script>

<div class="mx-auto mt-24 max-w-sm">
	<div class="rounded-box border border-base-300 bg-base-100 p-6">
		<h1 class="mb-1 text-xl font-semibold">deck</h1>
		<p class="mb-4 text-sm opacity-70">
			Paste the access token. It is stored in ~/.deck/token on the deck machine.
		</p>
		<form method="POST" bind:this={formEl} class="space-y-3">
			<input
				class="input w-full"
				type="password"
				name="token"
				placeholder="Access token"
				bind:value={token}
				autocomplete="off"
			/>
			{#if form?.wrong}
				<p class="m-0 text-sm text-error">That token is not right, or that sign-in was revoked.</p>
			{/if}
			<button class="btn w-full btn-primary" type="submit">Sign in</button>
		</form>
		<a href="/pair" class="mt-4 block text-center text-sm opacity-60 hover:opacity-100"
			>No token? Request access from a signed-in device</a
		>
	</div>
</div>
