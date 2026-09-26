<script lang="ts">
	import { patchSettings } from '$lib/settings-patch';
	import { AudioLines, Check, Search } from '@lucide/svelte';

	// App-wide panel: where voice mode's speech servers are. Both are
	// OpenAI-shaped endpoints deck proxies; the local chatterbox server offers
	// both halves, and Detect fills the fields from it in one click. Saved into
	// ~/.deck/settings.json (never the repo).

	let ttsUrl = $state('');
	let sttUrl = $state('');
	let voice = $state('');
	let voices = $state<string[]>([]);
	let status = $state<{ tts: boolean; stt: boolean } | null>(null);
	let loaded = $state(false);
	let busy = $state(false);
	let saved = $state(false);
	let message = $state('');

	async function load() {
		try {
			const res = await fetch('/api/speech');
			if (!res.ok) throw new Error('failed to load speech settings');
			const body = await res.json();
			ttsUrl = body.config?.ttsUrl ?? '';
			sttUrl = body.config?.sttUrl ?? '';
			voice = body.config?.voice ?? body.voice ?? '';
			voices = body.voices ?? [];
			status = { tts: body.tts, stt: body.stt };
		} catch (e) {
			message = e instanceof Error ? e.message : 'failed to load speech settings';
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		load();
	});

	async function detect() {
		busy = true;
		message = '';
		try {
			const res = await fetch('/api/speech/detect', { method: 'POST' });
			const body = await res.json();
			if (!body.found) {
				message = 'No speech server answered on 127.0.0.1:17496.';
				return;
			}
			ttsUrl = body.url;
			if (body.stt) sttUrl = body.url;
			voices = body.voices ?? [];
			if (!voice || !voices.includes(voice)) voice = body.voice ?? voices[0] ?? '';
			message = `Found the local server (${voices.length} voice${voices.length === 1 ? '' : 's'}). Save to use it.`;
		} catch {
			message = 'Detection failed.';
		} finally {
			busy = false;
		}
	}

	async function save() {
		busy = true;
		message = '';
		saved = false;
		try {
			const speech = {
				ttsUrl: ttsUrl.trim() || undefined,
				sttUrl: sttUrl.trim() || undefined,
				voice: voice.trim() || undefined
			};
			await patchSettings('speech', speech);
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
			<AudioLines size={16} /> Voice mode
			{#if status}
				<span class="badge badge-sm {status.tts ? 'badge-success' : 'badge-ghost'}">read {status.tts ? 'on' : 'off'}</span>
				<span class="badge badge-sm {status.stt ? 'badge-success' : 'badge-ghost'}">talk {status.stt ? 'on' : 'off'}</span>
			{/if}
		</h2>
		<p class="m-0 text-sm opacity-70">
			Reads a session's replies aloud and sends what you say. Point it at an OpenAI-shaped speech
			server (POST /v1/audio/speech and /v1/audio/transcriptions); deck proxies both so phones and
			browsers never reach the server directly.
		</p>
		{#if loaded}
			<div class="grid gap-2 sm:grid-cols-2">
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Text-to-speech URL</span>
					<input class="input input-sm w-full" placeholder="http://127.0.0.1:17496" bind:value={ttsUrl} />
				</label>
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Speech-to-text URL</span>
					<input class="input input-sm w-full" placeholder="http://127.0.0.1:17496" bind:value={sttUrl} />
				</label>
				<label class="form-control">
					<span class="label-text text-xs opacity-70">Voice</span>
					{#if voices.length}
						<select class="select select-sm w-full" bind:value={voice}>
							{#each voices as v (v)}
								<option value={v}>{v}</option>
							{/each}
						</select>
					{:else}
						<input class="input input-sm w-full" placeholder="server default" bind:value={voice} />
					{/if}
				</label>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<button class="btn btn-sm" onclick={detect} disabled={busy}>
					<Search size={14} /> Detect local server
				</button>
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
