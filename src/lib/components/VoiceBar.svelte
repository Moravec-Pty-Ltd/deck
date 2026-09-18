<script lang="ts">
	import { Mic, SkipForward, Square, Settings2, X } from '@lucide/svelte';
	import type { VoiceSession } from '$lib/voice.svelte';
	import { haptic } from '$lib/haptics';

	// The strip between the transcript and the composer while voice mode is on:
	// what is being read (or heard), hold-to-talk, Skip, Stop, and the per-device
	// settings (chattiness, hands-free, sensitivity). Desktop can hold the space
	// bar instead of the button, or click the button once to toggle a long take.

	let { voice }: { voice: VoiceSession } = $props();

	let showSettings = $state(false);
	let holding = $state(false);
	let toggled = $state(false);
	let spaceHeld = false;
	let downAt = 0;

	const recording = $derived(voice.recording);

	function onDown(e: PointerEvent) {
		if (e.button !== 0) return;
		if (toggled) {
			toggled = false;
			voice.stopRecording();
			haptic(15);
			return;
		}
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		holding = true;
		downAt = Date.now();
		haptic(15);
		void voice.startRecording();
	}

	function up(e: PointerEvent) {
		if (!holding) return;
		holding = false;
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
		// A quick tap toggles a long take; a hold sends on release; dragging off
		// the button first cancels.
		const brief = Date.now() - downAt < 250;
		if (!inside) {
			voice.cancelRecording();
			haptic([10, 20]);
		} else if (brief) {
			toggled = true;
		} else {
			voice.stopRecording();
			haptic(15);
		}
	}

	function isTyping(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.code !== 'Space' || e.repeat || spaceHeld || isTyping(e.target) || voice.settings.handsFree) return;
		e.preventDefault();
		spaceHeld = true;
		holding = true;
		void voice.startRecording();
	}

	function onKeyup(e: KeyboardEvent) {
		if (e.code !== 'Space' || !spaceHeld) return;
		e.preventDefault();
		spaceHeld = false;
		holding = false;
		voice.stopRecording();
	}

	const statusLabel = $derived.by(() => {
		switch (voice.status) {
			case 'speaking':
				return 'Reading';
			case 'listening':
				return voice.settings.handsFree && !recording ? 'Hands-free' : 'Listening';
			case 'transcribing':
				return 'Transcribing';
			default:
				return voice.ask ? 'Waiting for your answer' : 'Voice on';
		}
	});
</script>

<svelte:window onkeydown={onKeydown} onkeyup={onKeyup} />

<div class="-mx-2 border-t border-base-300 bg-base-200/60 px-3 py-2" role="region" aria-label="Voice mode">
	<div class="flex items-center gap-2">
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-1.5 text-xs opacity-60">
				<span class="inline-block h-2 w-2 rounded-full {voice.status === 'speaking' ? 'bg-info' : recording ? 'bg-error' : voice.status === 'transcribing' ? 'bg-warning' : 'bg-success'}"></span>
				{statusLabel}
				{#if voice.error}<span class="text-error">· {voice.error}</span>{/if}
			</div>
			<div class="truncate text-sm">{voice.caption || (voice.ask ? 'Say an option, its number, or a reply.' : 'Hold the button (or space) to talk.')}</div>
		</div>

		<button
			class="btn btn-ghost btn-sm btn-square"
			onclick={() => voice.skip()}
			disabled={voice.status !== 'speaking'}
			aria-label="Skip to the next reply"
			title="Skip"
		>
			<SkipForward size={16} />
		</button>
		<button class="btn btn-error btn-sm gap-1" onclick={() => voice.stop()} aria-label="Stop reading and interrupt">
			<Square size={14} /> <span class="hidden sm:inline">Stop</span>
		</button>
		<button
			class="btn btn-circle relative select-none touch-none {recording ? 'btn-error' : 'btn-primary'}"
			onpointerdown={onDown}
			onpointerup={up}
			onpointercancel={() => {
				holding = false;
				voice.cancelRecording();
			}}
			oncontextmenu={(e) => e.preventDefault()}
			disabled={!voice.canListen || voice.status === 'transcribing'}
			aria-pressed={recording}
			aria-label={recording ? 'Release to send' : 'Hold to talk'}
			title="Hold to talk · tap to toggle"
		>
			{#if recording}
				<span
					class="pointer-events-none absolute inset-0 rounded-full border-2 border-error-content/60"
					style="transform: scale({1 + voice.level * 0.6})"
				></span>
			{/if}
			<Mic size={18} />
		</button>
		<button
			class="btn btn-ghost btn-sm btn-square"
			onclick={() => (showSettings = !showSettings)}
			aria-label="Voice settings"
			aria-expanded={showSettings}
		>
			<Settings2 size={16} />
		</button>
	</div>

	{#if showSettings}
		<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-box border border-base-300 bg-base-100 p-2 text-sm">
			<label class="flex items-center gap-2">
				<span class="opacity-70">Read</span>
				<select
					class="select select-sm"
					value={voice.settings.chattiness}
					onchange={(e) => voice.updateSettings({ ...voice.settings, chattiness: (e.currentTarget as HTMLSelectElement).value as 'every-update' | 'final-only' })}
				>
					<option value="every-update">every update</option>
					<option value="final-only">final reply only</option>
				</select>
			</label>
			<label class="flex items-center gap-2">
				<input
					type="checkbox"
					class="toggle toggle-sm"
					checked={voice.settings.handsFree}
					disabled={!voice.canListen}
					onchange={(e) => voice.updateSettings({ ...voice.settings, handsFree: (e.currentTarget as HTMLInputElement).checked })}
				/>
				<span>Hands-free <span class="opacity-60">(experimental)</span></span>
			</label>
			{#if voice.settings.handsFree}
				<label class="flex items-center gap-2">
					<span class="opacity-70">Sensitivity</span>
					<select
						class="select select-sm"
						value={voice.settings.sensitivity}
						onchange={(e) => voice.updateSettings({ ...voice.settings, sensitivity: (e.currentTarget as HTMLSelectElement).value as 'low' | 'medium' | 'high' })}
					>
						<option value="low">low</option>
						<option value="medium">medium</option>
						<option value="high">high</option>
					</select>
				</label>
			{/if}
			<button class="btn btn-ghost btn-xs ml-auto" onclick={() => (showSettings = false)} aria-label="Close voice settings">
				<X size={14} />
			</button>
		</div>
	{/if}
</div>
