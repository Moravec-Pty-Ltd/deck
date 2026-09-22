<script lang="ts">
	import { tick } from 'svelte';
	import { AudioLines, Send, Trash2, X } from '@lucide/svelte';
	import { operatorUi } from '$lib/operator-ui.svelte';
	import {
		announcementEntry,
		errorEntry,
		failureText,
		fromHistory,
		replyEntry,
		userEntry,
		type OperatorLogEntry,
		type OperatorReplyBody
	} from '$lib/operator-client';
	import { VoiceSession } from '$lib/voice.svelte';
	import VoiceBar from './VoiceBar.svelte';
	import { relativeTime } from '$lib/time';

	// The voice operator: a conversation with the small model that drives
	// sessions for you. Spoken turns go through the same VoiceSession the
	// per-session voice mode uses (hold-to-talk or the open-mic mode), with the
	// operator as the place a transcript is delivered; typed turns go straight
	// in. While the drawer is open it also listens for what the operator says
	// on its own (questions, finished turns, errors) and reads those out.

	let log = $state<OperatorLogEntry[]>([]);
	let text = $state('');
	let busy = $state(false);
	let configured = $state<boolean | null>(null);
	let model = $state('');
	let scroller = $state<HTMLDivElement>();
	let events: EventSource | null = null;

	const voice = new VoiceSession({
		send: (spoken) => send(spoken),
		answer: async () => {},
		interrupt: async () => {}
	});

	$effect(() => {
		if (operatorUi.open) void open();
		else close();
	});

	async function open() {
		await voice.loadCapabilities();
		await voice.enable();
		await Promise.all([loadStatus(), loadHistory()]);
		listen();
	}

	function close() {
		voice.disable();
		events?.close();
		events = null;
	}

	async function loadStatus() {
		try {
			const res = await fetch('/api/operator');
			const body = (await res.json()) as { configured: boolean; model: string | null };
			configured = body.configured;
			model = body.model ?? '';
		} catch {
			configured = false;
		}
	}

	async function loadHistory() {
		try {
			const res = await fetch('/api/operator/history?limit=60');
			if (res.ok) log = fromHistory(((await res.json()) as { turns: Parameters<typeof fromHistory>[0] }).turns);
		} catch {
			// The drawer works without history.
		}
		await scrollToEnd();
	}

	// Holding the stream open is what turns the operator's own announcements on.
	function listen() {
		events?.close();
		events = new EventSource('/api/operator/events');
		events.addEventListener('announcement', (e) => {
			const a = JSON.parse((e as MessageEvent).data) as { text: string; at: number };
			log = [...log, announcementEntry(a.text, a.at)];
			void voice.speak(a.text);
			void scrollToEnd();
		});
	}

	async function send(spoken: string) {
		const message = spoken.trim();
		if (!message || busy) return;
		busy = true;
		log = [...log, userEntry(message, Date.now())];
		await scrollToEnd();
		try {
			const res = await fetch('/api/operator', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: message, source: 'web' })
			});
			if (!res.ok) {
				const detail = ((await res.json().catch(() => ({}))) as { message?: string }).message ?? '';
				log = [...log, errorEntry(failureText(res.status, detail), Date.now())];
				return;
			}
			const reply = (await res.json()) as OperatorReplyBody;
			log = [...log, replyEntry(reply, Date.now())];
			void voice.speak(reply.text);
		} catch (e) {
			log = [...log, errorEntry(e instanceof Error ? e.message : 'request failed', Date.now())];
		} finally {
			busy = false;
			await scrollToEnd();
		}
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const message = text;
		text = '';
		void send(message);
	}

	async function reset() {
		await fetch('/api/operator/reset', { method: 'POST' });
		log = [];
	}

	async function scrollToEnd() {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight });
	}
</script>

{#if operatorUi.open}
	<aside class="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-base-300 bg-base-100 shadow-xl" aria-label="Operator">
		<div class="flex items-center gap-2 border-b border-base-300 px-3 py-2">
			<AudioLines size={18} class="opacity-70" />
			<div class="min-w-0 flex-1">
				<div class="text-sm font-semibold">Operator</div>
				<div class="truncate text-xs opacity-60">
					{#if configured === false}
						no model configured
					{:else if model}
						{model}
					{/if}
				</div>
			</div>
			<button class="btn btn-square btn-ghost btn-sm" onclick={reset} title="Clear the conversation" aria-label="Clear the conversation">
				<Trash2 size={16} />
			</button>
			<button class="btn btn-square btn-ghost btn-sm" onclick={() => (operatorUi.open = false)} aria-label="Close operator">
				<X size={16} />
			</button>
		</div>

		<div bind:this={scroller} class="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
			{#if configured === false}
				<p class="text-sm opacity-70">
					Add an <code>operator</code> block with <code>url</code> and <code>model</code> to <code>~/.deck/settings.json</code>, pointing at an OpenAI-compatible chat endpoint.
				</p>
			{:else if !log.length}
				<p class="text-sm opacity-60">
					Ask what is going on, have a reply read out, send a session an instruction, answer its question, or start a session with a skill. While this is open the operator also tells you about new questions, finished turns and errors.
				</p>
			{/if}
			{#each log as e (e.id)}
				<div class="chat {e.role === 'user' ? 'chat-end' : 'chat-start'}">
					<div
						class="chat-bubble max-w-[90%] text-sm wrap-anywhere {e.role === 'user'
							? 'bg-base-300 text-base-content'
							: e.error
								? 'bg-error/15 text-base-content'
								: 'bg-base-200 text-base-content'}"
					>
						{#if e.announcement}<span class="mr-1 text-xs opacity-60">said</span>{/if}{e.text}
						{#if e.actions?.length}
							<ul class="mt-1 space-y-0.5 text-xs opacity-60">
								{#each e.actions as a, i (i)}<li>{a}</li>{/each}
							</ul>
						{/if}
					</div>
					<div class="chat-footer text-xs opacity-40">{relativeTime(e.at)}</div>
				</div>
			{/each}
			{#if busy}
				<div class="chat chat-start"><div class="chat-bubble bg-base-200 text-sm"><span class="loading loading-dots loading-xs"></span></div></div>
			{/if}
		</div>

		{#if voice.enabled}
			<div class="border-t border-base-300"><VoiceBar {voice} /></div>
		{/if}
		<form class="flex gap-2 border-t border-base-300 p-2" onsubmit={submit}>
			<input class="input input-sm flex-1" placeholder="Or type to the operator" bind:value={text} disabled={busy || configured === false} />
			<button class="btn btn-square btn-sm btn-primary" type="submit" disabled={busy || !text.trim()} aria-label="Send">
				<Send size={16} />
			</button>
		</form>
	</aside>
{/if}
