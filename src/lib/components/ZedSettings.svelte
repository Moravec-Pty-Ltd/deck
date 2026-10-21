<script lang="ts">
	import { onMount } from 'svelte';
	import { Check } from '@lucide/svelte';
	import { fetchSettings, patchSettings } from '$lib/settings-patch';

	// The SSH target the session page's "Open in Zed" command uses. Blank means
	// the deck server's user at the host this browser reached deck on.
	let target = $state('');
	let loaded = $state(false);
	let busy = $state(false);
	let saved = $state(false);
	let message = $state('');

	async function load() {
		try {
			target = (await fetchSettings()).zedSshTarget ?? '';
			loaded = true;
		} catch (e) {
			message = e instanceof Error ? e.message : "Couldn't load editor settings";
		}
	}

	onMount(() => {
		void load();
	});

	async function save() {
		busy = true;
		message = '';
		saved = false;
		try {
			await patchSettings({ zedSshTarget: target.trim() || null });
			saved = true;
			await load();
		} catch (e) {
			message = e instanceof Error ? e.message : 'Save failed';
		} finally {
			busy = false;
		}
	}
</script>

<div class="card border border-base-300 bg-base-100">
	<div class="card-body gap-3 p-4">
		{#if loaded}
			<label class="form-control max-w-md">
				<span class="label-text text-xs opacity-70">Zed SSH target</span>
				<input
					class="input input-sm w-full font-mono"
					placeholder="user@host:22"
					autocomplete="off"
					spellcheck="false"
					bind:value={target}
				/>
			</label>
			<p class="m-0 text-xs opacity-70">
				Leave blank to use this server's user at the host you reached deck on. Set it when SSH
				goes somewhere else, such as a different user or port.
			</p>
			<div class="flex items-center gap-2">
				<button class="btn btn-sm btn-primary" onclick={save} disabled={busy}>Save</button>
				{#if saved}
					<span class="flex items-center gap-1 text-xs text-success"><Check size={14} /> Saved</span>
				{/if}
			</div>
		{/if}
		{#if message}
			<span class="text-xs text-error">{message}</span>
		{/if}
	</div>
</div>
