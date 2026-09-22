<script lang="ts">
	import { Check, MessageSquareText } from '@lucide/svelte';
	import type { DeckSettings } from '$lib/types';

	// App-wide panel: the model behind the voice operator, any OpenAI-compatible
	// chat endpoint (a local mlx_lm.server by default). Saved to
	// ~/.deck/settings.json only, so a private host never lands in the repo.
	let url = $state('');
	let model = $state('');
	let apiKey = $state('');
	let loaded = $state(false);
	let busy = $state(false);
	let saved = $state(false);
	let message = $state('');
	let status = $state<{ configured: boolean; model: string | null } | null>(null);

	async function load() {
		try {
			const settings: DeckSettings = await fetch('/api/settings').then((r) => (r.ok ? r.json() : {}));
			url = settings.operator?.url ?? '';
			model = settings.operator?.model ?? '';
			apiKey = settings.operator?.apiKey ?? '';
			status = await fetch('/api/operator').then((r) => (r.ok ? r.json() : null));
			loaded = true;
		} catch (e) {
			message = e instanceof Error ? e.message : 'failed to load operator settings';
		}
	}

	$effect(() => {
		void load();
	});

	async function save() {
		busy = true;
		message = '';
		saved = false;
		try {
			const current: DeckSettings = await fetch('/api/settings').then((r) => (r.ok ? r.json() : {}));
			const operator = {
				url: url.trim() || undefined,
				model: model.trim() || undefined,
				apiKey: apiKey.trim() || undefined
			};
			const res = await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...current, operator })
			});
			if (!res.ok) throw new Error('save failed');
			saved = true;
			await load();
		} catch (e) {
			message = e instanceof Error ? e.message : 'save failed';
		} finally {
			busy = false;
		}
	}
</script>

<div class="card border border-base-300 bg-base-100">
	<div class="card-body gap-3 p-4">
		<h2 class="m-0 flex items-center gap-2 text-base font-semibold">
			<MessageSquareText size={16} /> Operator
			{#if status}
				<span class="badge badge-sm {status.configured ? 'badge-success' : 'badge-ghost'}">{status.configured ? 'on' : 'off'}</span>
			{/if}
		</h2>
		<p class="m-0 text-sm opacity-70">
			The hands-free operator: a model that talks with you and drives sessions (status, replies,
			messages, answers, starting and stopping). Any OpenAI-compatible chat endpoint with tool calling;
			a local mlx_lm.server keeps it on this machine. Voice mode above supplies the ears and voice.
		</p>
		{#if loaded}
			<div class="grid gap-2 sm:grid-cols-3">
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Endpoint (base URL ending in /v1)</span>
					<input class="input input-sm w-full" placeholder="http://127.0.0.1:17498/v1" bind:value={url} />
				</label>
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Model</span>
					<input class="input input-sm w-full" placeholder="mlx-community/Qwen3.5-35B-A3B-4bit" bind:value={model} />
				</label>
				<label class="form-control">
					<span class="label-text text-xs opacity-70">API key (if the endpoint needs one)</span>
					<input class="input input-sm w-full" type="password" autocomplete="off" bind:value={apiKey} />
				</label>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<button class="btn btn-sm btn-primary" onclick={save} disabled={busy}>Save</button>
				{#if saved}
					<span class="flex items-center gap-1 text-xs text-success"><Check size={14} /> saved</span>
				{/if}
				{#if message}
					<span class="text-xs opacity-70">{message}</span>
				{/if}
			</div>
		{/if}
	</div>
</div>
