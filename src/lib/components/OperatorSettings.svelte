<script lang="ts">
	import { Check, MessageSquareText } from '@lucide/svelte';
	import { fetchSettings, patchSettings } from '$lib/settings-patch';

	// Somewhere to start from: the local model that fits a small machine, the
	// bigger local one, a tailnet server, and Claude.
	const PRESETS: { label: string; url: string; model: string; provider: '' | 'openai' | 'anthropic'; apiKeyFile?: string }[] = [
		{ label: 'Local (light)', url: 'http://127.0.0.1:17498/v1', model: 'mlx-community/Qwen3.5-9B-MLX-4bit', provider: 'openai' },
		{ label: 'Local (large)', url: 'http://127.0.0.1:17498/v1', model: 'mlx-community/Qwen3.5-35B-A3B-4bit', provider: 'openai' },
		{ label: 'Tailnet', url: 'http://strix-halo:8000/v1', model: '', provider: 'openai' },
		{ label: 'Claude', url: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5-20251001', provider: 'anthropic', apiKeyFile: '~/.secrets/anthropic.env' }
	];

	// App-wide panel: the model behind the voice operator, any OpenAI-compatible
	// chat endpoint (a local mlx_lm.server by default). Saved to
	// ~/.deck/settings.json only, so a private host never lands in the repo.
	let url = $state('');
	let model = $state('');
	let provider = $state<'' | 'openai' | 'anthropic'>('');
	let apiKey = $state('');
	let apiKeyFile = $state('');
	let loaded = $state(false);
	let busy = $state(false);
	let saved = $state(false);
	let message = $state('');
	let status = $state<{ configured: boolean; model: string | null; provider?: string } | null>(null);

	async function load() {
		try {
			const settings = await fetchSettings();
			url = settings.operator?.url ?? '';
			model = settings.operator?.model ?? '';
			provider = settings.operator?.provider ?? '';
			apiKey = settings.operator?.apiKey ?? '';
			apiKeyFile = settings.operator?.apiKeyFile ?? '';
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
			const operator = {
				url: url.trim() || undefined,
				model: model.trim() || undefined,
				provider: provider || undefined,
				apiKey: apiKey.trim() || undefined,
				apiKeyFile: apiKeyFile.trim() || undefined
			};
			await patchSettings('operator', operator);
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
			messages, answers, starting and stopping). Any chat endpoint with tool calling, OpenAI-shaped
			(a local mlx_lm.server or llama-server, a machine on your tailnet, most hosted models) or
			Anthropic-shaped (Claude). Voice mode above supplies the ears and voice.
		</p>
		<div class="flex flex-wrap gap-2">
			{#each PRESETS as preset (preset.label)}
				<button
					class="btn btn-xs"
					onclick={() => {
						url = preset.url;
						model = preset.model;
						provider = preset.provider;
						apiKeyFile = preset.apiKeyFile ?? '';
					}}
				>
					{preset.label}
				</button>
			{/each}
		</div>
		{#if loaded}
			<div class="grid gap-2 sm:grid-cols-2">
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Endpoint (base URL ending in /v1)</span>
					<input class="input input-sm w-full" placeholder="http://127.0.0.1:17498/v1" bind:value={url} />
				</label>
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Model</span>
					<input class="input input-sm w-full" placeholder="mlx-community/Qwen3.5-9B-MLX-4bit" bind:value={model} />
				</label>
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Shape</span>
					<select class="select select-sm w-full" bind:value={provider}>
						<option value="">From the URL</option>
						<option value="openai">OpenAI-compatible</option>
						<option value="anthropic">Anthropic (Claude)</option>
					</select>
				</label>
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Key file (preferred: a path under ~/.secrets)</span>
					<input class="input input-sm w-full" placeholder="~/.secrets/anthropic.env" autocomplete="off" bind:value={apiKeyFile} />
				</label>
				<label class="form-control sm:col-span-2">
					<span class="label-text text-xs opacity-70">API key (only if you would rather store it here)</span>
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
