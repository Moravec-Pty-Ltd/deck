<script lang="ts">
	let token = $state('');

	function go(e: Event) {
		e.preventDefault();
		if (token.trim()) location.href = `/?token=${encodeURIComponent(token.trim())}`;
	}
</script>

<div class="mx-auto mt-24 max-w-sm">
	<div class="rounded-box border border-base-300 bg-base-100 p-6">
		<h1 class="mb-1 text-xl font-semibold">deck</h1>
		<p class="mb-4 text-sm opacity-70">
			Paste the access token. It is printed by the server on startup and stored in ~/.deck/token.
		</p>
		<form onsubmit={go} class="space-y-3">
			<input
				class="input w-full"
				type="password"
				placeholder="access token"
				bind:value={token}
				autocomplete="off"
			/>
			<button class="btn w-full btn-primary" type="submit">Sign in</button>
		</form>
		<a href="/pair" class="mt-4 block text-center text-sm opacity-60 hover:opacity-100"
			>No token? Request access from a signed-in device</a
		>
	</div>
</div>
