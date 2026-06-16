<script lang="ts">
	import type { DeckSession } from '$lib/types';
	import Linked from './Linked.svelte';
	import { Send, Square, Wrench, ChevronDown, ArrowDown } from '@lucide/svelte';

	let { session }: { session: DeckSession } = $props();

	type AnyEvent = Record<string, any>;

	let events = $state<AnyEvent[]>([]);
	let status = $state<string>(session.status);
	let liveText = $state('');
	let input = $state('');
	let scroller: HTMLDivElement | undefined = $state();
	let atBottom = $state(true);

	$effect(() => {
		const source = new EventSource(`/api/sessions/${encodeURIComponent(session.id)}/events`);
		source.addEventListener('transcript', (e) => {
			const ev = JSON.parse(e.data);
			if (ev.type === 'stream_event') {
				handleStream(ev);
				return;
			}
			if (ev.type === 'assistant') liveText = '';
			events = [...events, ev];
			maybeScroll();
		});
		source.addEventListener('status', (e) => {
			status = JSON.parse(e.data);
			if (status !== 'running') liveText = '';
		});
		return () => source.close();
	});

	function handleStream(ev: AnyEvent) {
		const t = ev.event?.type;
		if (t === 'message_start') {
			liveText = '';
		} else if (t === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
			liveText += ev.event.delta.text;
			maybeScroll();
		}
	}

	function onScroll() {
		if (!scroller) return;
		atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
	}

	function maybeScroll() {
		if (atBottom) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
	}

	function forceScroll() {
		scroller?.scrollTo({ top: scroller.scrollHeight });
		atBottom = true;
	}

	async function send() {
		const text = input.trim();
		if (!text) return;
		input = '';
		atBottom = true;
		await fetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text })
		});
	}

	async function interrupt() {
		await fetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'interrupt' })
		});
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			send();
		}
	}

	function contentBlocks(event: AnyEvent): AnyEvent[] {
		const content = event.message?.content;
		return Array.isArray(content) ? content : [];
	}

	function toolResultText(block: AnyEvent): string {
		if (typeof block.content === 'string') return block.content;
		if (Array.isArray(block.content)) {
			return block.content
				.filter((c: AnyEvent) => c.type === 'text')
				.map((c: AnyEvent) => c.text)
				.join('\n');
		}
		return JSON.stringify(block.content ?? '', null, 2);
	}

	function fmtCost(event: AnyEvent): string {
		const parts: string[] = [];
		if (typeof event.duration_ms === 'number') parts.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
		if (typeof event.num_turns === 'number') parts.push(`${event.num_turns} turns`);
		if (typeof event.total_cost_usd === 'number') parts.push(`$${event.total_cost_usd.toFixed(4)}`);
		if (event.subtype && event.subtype !== 'success') parts.push(event.subtype);
		return parts.join(' · ');
	}
</script>

<div class="relative flex h-full min-h-0 flex-col">
	<div
		bind:this={scroller}
		onscroll={onScroll}
		class="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-3"
	>
		{#each events as event, i (i)}
			{#if event.type === 'deck.user'}
				<div class="chat chat-end">
					<div class="chat-bubble chat-bubble-primary whitespace-pre-wrap"><Linked text={event.text} /></div>
				</div>
			{:else if event.type === 'deck.error'}
				<div class="alert alert-error py-2 text-sm whitespace-pre-wrap">{event.text}</div>
			{:else if event.type === 'assistant'}
				{#each contentBlocks(event) as block, j (j)}
					{#if block.type === 'text' && block.text?.trim()}
						<div class="chat chat-start">
							<div class="chat-bubble whitespace-pre-wrap bg-base-100 text-base-content">
								<Linked text={block.text} />
							</div>
						</div>
					{:else if block.type === 'thinking' && block.thinking?.trim()}
						<details class="px-2 text-xs opacity-50">
							<summary class="cursor-pointer select-none">
								<ChevronDown size={12} class="inline" /> thinking
							</summary>
							<pre class="whitespace-pre-wrap pt-1">{block.thinking}</pre>
						</details>
					{:else if block.type === 'tool_use'}
						<details class="mx-2 rounded-box border border-base-300 bg-base-100 px-3 py-1.5 text-sm">
							<summary class="cursor-pointer select-none">
								<Wrench size={13} class="inline opacity-60" />
								<span class="font-medium">{block.name}</span>
								<span class="opacity-50">
									{(block.input?.description ?? block.input?.command ?? block.input?.file_path ?? '')
										.toString()
										.slice(0, 80)}
								</span>
							</summary>
							<pre class="terminal-output max-h-60 overflow-y-auto pt-2 opacity-80">{JSON.stringify(
									block.input,
									null,
									2
								)}</pre>
						</details>
					{/if}
				{/each}
			{:else if event.type === 'user'}
				{#each contentBlocks(event) as block, j (j)}
					{#if block.type === 'tool_result'}
						<details class="mx-2 px-3 text-xs opacity-60">
							<summary class="cursor-pointer select-none">tool result</summary>
							<pre class="terminal-output max-h-60 overflow-y-auto pt-1">{toolResultText(block).slice(
									0,
									4000
								)}</pre>
						</details>
					{/if}
				{/each}
			{:else if event.type === 'result'}
				<div class="px-2 text-center text-xs opacity-50">{fmtCost(event)}</div>
			{/if}
		{/each}

		{#if liveText.trim()}
			<div class="chat chat-start">
				<div class="chat-bubble whitespace-pre-wrap bg-base-100 text-base-content">
					<Linked text={liveText} />
				</div>
			</div>
		{:else if status === 'running'}
			<div class="px-2 text-sm opacity-60">working...</div>
		{/if}
	</div>

	{#if !atBottom}
		<button
			class="btn btn-circle btn-sm absolute bottom-28 left-1/2 -translate-x-1/2 shadow"
			onclick={forceScroll}
			aria-label="Jump to latest"
		>
			<ArrowDown size={16} />
		</button>
	{/if}

	<div class="border-t border-base-300 bg-base-100 p-3">
		<div class="flex items-end gap-2">
			<textarea
				class="textarea min-h-12 flex-1"
				rows="2"
				placeholder={status === 'running'
					? 'queue a follow-up (ctrl/cmd+enter)'
					: 'message (ctrl/cmd+enter to send)'}
				bind:value={input}
				onkeydown={onKeydown}
			></textarea>
			{#if status === 'running'}
				<button class="btn btn-error" onclick={interrupt} aria-label="Interrupt">
					<Square size={16} /> Interrupt
				</button>
			{/if}
			<button class="btn btn-primary" onclick={send} disabled={!input.trim()} aria-label="Send">
				<Send size={16} /> Send
			</button>
		</div>
	</div>
</div>
