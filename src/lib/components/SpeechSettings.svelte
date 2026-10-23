<script lang="ts">
	import { patchSettings } from '$lib/settings-patch';
	import { Check, Search } from '@lucide/svelte';

	// App-wide panel: where voice mode's speech servers are. Both are
	// OpenAI-shaped endpoints deck proxies; the local chatterbox server offers
	// both halves, and Detect fills the fields from it in one click. Saved into
	// ~/.deck/settings.json (never the repo).

	let ttsUrl = $state('');
	let sttUrl = $state('');
	let streamUrl = $state('');
	let voice = $state('');
	let voices = $state<string[]>([]);
	let status = $state<{ tts: boolean; stt: boolean; stream: boolean } | null>(null);
	let loaded = $state(false);
	let busy = $state(false);
	let saved = $state(false);
	let message = $state('');

	async function load() {
		try {
			const res = await fetch('/api/agent/speech');
			if (!res.ok) throw new Error("Couldn't load speech settings");
			const body = await res.json();
			ttsUrl = body.config?.ttsUrl ?? '';
			sttUrl = body.config?.sttUrl ?? '';
			streamUrl = body.config?.streamUrl ?? '';
			voice = body.config?.voice ?? body.voice ?? '';
			voices = body.voices ?? [];
			status = { tts: body.tts, stt: body.stt, stream: body.stream };
		} catch (e) {
			message = e instanceof Error ? e.message : "Couldn't load speech settings";
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
			const res = await fetch('/api/agent/settings/speech/detect', { method: 'POST' });
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
			await patchSettings({ speech: { ttsUrl: ttsUrl.trim(), sttUrl: sttUrl.trim(), streamUrl: streamUrl.trim(), voice: voice.trim() } });
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
		{#if status}
			<div class="flex flex-wrap items-center gap-2">
				<span class="badge badge-sm {status.tts ? 'badge-success' : 'badge-ghost'}">Read aloud {status.tts ? 'on' : 'off'}</span>
				<span class="badge badge-sm {status.stt ? 'badge-success' : 'badge-ghost'}">Dictation {status.stt ? 'on' : 'off'}</span>
				<span class="badge badge-sm {status.stream ? 'badge-success' : 'badge-ghost'}">Live transcription {status.stream ? 'on' : 'off'}</span>
			</div>
		{/if}
		<p class="m-0 text-xs opacity-70">
			Any OpenAI-shaped speech server (POST /v1/audio/speech and /v1/audio/transcriptions). deck
			proxies both, so phones and browsers never reach the server directly. A streaming URL (an
			OpenAI Realtime transcription WebSocket) is optional: with it, a take ends soon after a
			finished sentence instead of waiting out the full pause.
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
					<span class="label-text text-xs opacity-70">Streaming speech-to-text URL</span>
					<input class="input input-sm w-full" placeholder="ws://127.0.0.1:8000/v1/realtime?model=..." bind:value={streamUrl} />
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
						<input class="input input-sm w-full" placeholder="Server default" bind:value={voice} />
					{/if}
				</label>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<button class="btn btn-sm" onclick={detect} disabled={busy}>
					<Search size={14} /> Detect local server
				</button>
				<button class="btn btn-sm btn-primary" onclick={save} disabled={busy}>Save</button>
				{#if saved}
					<span class="flex items-center gap-1 text-xs text-success"><Check size={14} /> Saved</span>
				{/if}
				{#if message}
					<span class="text-xs opacity-70">{message}</span>
				{/if}
			</div>
		{/if}
	</div>
</div>
