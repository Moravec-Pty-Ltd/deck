<script lang="ts">
	import { tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { DeckSession } from '$lib/types';
	import { indexForward, indexOlderBatch, type Answer } from '$lib/transcript-index';
	import Linked from './Linked.svelte';
	import ToolCall from './ToolCall.svelte';
	import AskQuestion from './AskQuestion.svelte';
	import { Send, Square, ChevronDown, ArrowDown, Paperclip, X } from '@lucide/svelte';

	let { session }: { session: DeckSession } = $props();

	type AnyEvent = Record<string, any>;

	let events = $state<AnyEvent[]>([]);
	let status = $state<string>(session.status);
	let liveText = $state('');
	let input = $state('');
	let scroller: HTMLDivElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();
	let atBottom = $state(true);
	let dragging = $state(false);
	let connected = $state(true);
	let loaded = $state(false);

	type Attachment = { media_type: string; data: string; url: string };
	let attachments = $state<Attachment[]>([]);

	// Render only the tail at first, then widen the window in the background so
	// opening a long session paints immediately instead of mounting thousands of
	// nodes up front. `start` is the absolute index of the first rendered event,
	// which we also use as the keyed-each key so widening reuses existing nodes.
	const INITIAL_WINDOW = 60;
	const HYDRATE_CHUNK = 250;
	let limit = $state(INITIAL_WINDOW);
	// Absolute index of events[0]. The snapshot only carries recent history;
	// `baseIndex > 0` means older events live on the server and can be lazily
	// pulled in via /transcript. Keyed-each uses baseIndex+start+i (an event's
	// stable absolute index) so prepending older rows still reuses nodes.
	let baseIndex = $state(0);
	const start = $derived(Math.max(0, events.length - limit));
	const visible = $derived(events.slice(start));

	// Two lookups the template needs while rendering the visible window:
	//   resultsById       — tool_use_id → its tool_result block (ToolCall)
	//   answeredQuestions  — ask tool_use id → the chosen answers (AskQuestion)
	// Questions go through deck's blocking MCP `ask` tool; the pick is posted to
	// /answer, which resolves the still-open tool call (continuing the same turn)
	// and records a deck.answer marker so the chosen options persist on reload.
	//
	// Maintained incrementally as events arrive rather than re-derived over the
	// whole transcript on every event: a long, hydrated session would otherwise
	// re-scan thousands of events twice per streamed event. `$lib/transcript-index`
	// holds what each event contributes; we fold those into reactive maps here.
	const resultsById = new SvelteMap<string, AnyEvent>();
	const answeredQuestions = new SvelteMap<string, Answer[]>();
	const index = { results: resultsById, answered: answeredQuestions };

	function clearIndex() {
		resultsById.clear();
		answeredQuestions.clear();
	}

	// Rebuild both maps from a full list (a fresh snapshot replaces the transcript).
	function reindex(list: AnyEvent[]) {
		clearIndex();
		for (const ev of list) indexForward(index, ev);
	}

	function isAskTool(block: AnyEvent): boolean {
		return block.name === 'mcp__deck__ask' || block.name === 'AskUserQuestion';
	}

	async function answerQuestion(
		id: string,
		text: string,
		answers: { header: string; labels: string[] }[]
	) {
		atBottom = true;
		await fetch(`/api/sessions/${encodeURIComponent(session.id)}/answer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text, toolUseId: id, answers })
		});
	}

	// One subscription per session. The body depends only on session.id, so it
	// re-runs exactly when the viewed session changes — never on its own writes.
	$effect(() => {
		const id = session.id;

		// Clear the previous session synchronously so its history and live stream
		// can't bleed into this one while the new snapshot is in flight.
		events = [];
		clearIndex();
		baseIndex = 0;
		limit = INITIAL_WINDOW;
		liveText = '';
		loaded = false;
		status = session.status;

		let source: EventSource | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;

		const connect = () => {
			clearTimeout(retry);
			source?.close();
			const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
			source = es;
			// Recent history arrives as several small frames (the server can't push
			// one big frame reliably). Reassemble the serialized payload by `seq`,
			// then parse once. `seq === 0` resets the buffer, so a reconnect replaces
			// the array rather than re-appending the whole transcript.
			let snapBuf = '';
			es.addEventListener('snapshot', async (e) => {
				connected = true;
				let frame: { seq: number; n: number; data: string };
				try {
					frame = JSON.parse((e as MessageEvent).data);
				} catch {
					return;
				}
				if (stopped) return;
				if (frame.seq === 0) snapBuf = '';
				snapBuf += frame.data;
				if (frame.seq + 1 < frame.n) return; // wait for the rest
				let snap: { start: number; events: AnyEvent[] };
				try {
					snap = JSON.parse(snapBuf);
				} catch {
					return;
				}
				snapBuf = '';
				events = snap.events;
				reindex(snap.events);
				baseIndex = snap.start;
				limit = INITIAL_WINDOW;
				liveText = '';
				loaded = true;
				await tick();
				forceScroll();
				hydrateRest();
			});
			es.addEventListener('transcript', (e) => {
				const ev = JSON.parse((e as MessageEvent).data);
				if (ev.type === 'stream_event') {
					handleStream(ev);
					return;
				}
				if (ev.type === 'assistant') liveText = '';
				events.push(ev); // in-place: a full re-spread is O(n) on every event
				indexForward(index, ev);
				limit += 1; // keep the new event in view without dropping a tail row
				maybeScroll();
			});
			es.addEventListener('status', (e) => {
				status = JSON.parse((e as MessageEvent).data);
				if (status !== 'running') liveText = '';
			});
			es.addEventListener('ping', () => (connected = true));
			es.onopen = () => (connected = true);
			es.onerror = () => {
				connected = false;
				// EventSource retries on its own while CONNECTING; only step in once
				// it has actually given up (CLOSED), e.g. a hard network drop.
				if (!stopped && es.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2000);
			};
		};

		// A backgrounded tab (mobile/PWA) often loses its socket without firing an
		// error, so the stream silently stalls and nothing comes back. Re-open when
		// the tab is shown again or the network returns, if the socket isn't open.
		const wake = () => {
			if (document.visibilityState === 'visible' && source?.readyState !== EventSource.OPEN) {
				connect();
			}
		};
		document.addEventListener('visibilitychange', wake);
		window.addEventListener('online', wake);

		connect();

		return () => {
			stopped = true;
			clearTimeout(retry);
			document.removeEventListener('visibilitychange', wake);
			window.removeEventListener('online', wake);
			source?.close();
		};
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
		// Scrolling toward the top: widen the window over loaded rows, then pull
		// older history from the server once the loaded slice is exhausted.
		if (scroller.scrollTop < 400) {
			if (limit < events.length) hydrateRest();
			else loadOlder();
		}
	}

	function maybeScroll() {
		if (atBottom) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
	}

	function forceScroll() {
		scroller?.scrollTo({ top: scroller.scrollHeight });
		atBottom = true;
	}

	const idle: (cb: () => void) => void =
		typeof requestIdleCallback === 'function'
			? (cb) => requestIdleCallback(() => cb(), { timeout: 200 })
			: (cb) => setTimeout(cb, 16);

	// Widen the window by `by` older rows. They mount above the viewport, so re-pin
	// by the distance to the bottom: a bottom-anchored view stays pinned, and a
	// scrolled-up reader keeps the same messages in place instead of jumping.
	async function growWindow(by: number) {
		if (limit >= events.length) return;
		const gap = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
		limit = Math.min(events.length, limit + by);
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight - gap;
	}

	let hydrating = false;
	function hydrateRest() {
		if (hydrating || limit >= events.length) return;
		hydrating = true;
		const step = () => {
			if (limit >= events.length) {
				hydrating = false;
				return;
			}
			growWindow(HYDRATE_CHUNK).then(() => idle(step));
		};
		idle(step);
	}

	// Fetch the slice of history just before what's loaded and prepend it,
	// holding scroll position (same gap trick as growWindow). `baseIndex` walks
	// back toward 0; at 0 there's nothing older to load.
	let loadingOlder = $state(false);
	async function loadOlder() {
		if (loadingOlder || baseIndex <= 0) return;
		loadingOlder = true;
		try {
			const res = await fetch(
				`/api/sessions/${encodeURIComponent(session.id)}/transcript?before=${baseIndex}&limit=${HYDRATE_CHUNK}`
			);
			if (!res.ok) return;
			const slice: { start: number; events: AnyEvent[] } = await res.json();
			const added = baseIndex - slice.start;
			if (added <= 0) {
				baseIndex = slice.start;
				return;
			}
			const gap = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
			events.unshift(...slice.events);
			indexOlderBatch(index, slice.events);
			baseIndex = slice.start;
			limit += added; // keep the just-loaded rows inside the render window
			await tick();
			if (scroller) scroller.scrollTop = scroller.scrollHeight - gap;
		} finally {
			loadingOlder = false;
		}
	}

	function toBase64(buf: ArrayBuffer): string {
		let bin = '';
		const bytes = new Uint8Array(buf);
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		return btoa(bin);
	}

	async function addFile(file: File) {
		if (!file.type.startsWith('image/')) return;
		const data = toBase64(await file.arrayBuffer());
		attachments = [...attachments, { media_type: file.type, data, url: `data:${file.type};base64,${data}` }];
	}

	function onPaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (const it of items) {
			if (it.kind === 'file' && it.type.startsWith('image/')) {
				const f = it.getAsFile();
				if (f) addFile(f);
			}
		}
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		const files = e.dataTransfer?.files;
		if (files) for (const f of files) addFile(f);
	}

	function onPick(e: Event) {
		const files = (e.target as HTMLInputElement).files;
		if (files) for (const f of files) addFile(f);
		(e.target as HTMLInputElement).value = '';
	}

	function removeAttachment(i: number) {
		attachments = attachments.filter((_, k) => k !== i);
	}

	const canSend = $derived(!!input.trim() || attachments.length > 0);

	async function send() {
		if (!canSend) return;
		const text = input.trim();
		const images = attachments.map((a) => ({ media_type: a.media_type, data: a.data }));
		input = '';
		attachments = [];
		atBottom = true;
		await fetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text, images: images.length ? images : undefined })
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

	function fmtCost(event: AnyEvent): string {
		const parts: string[] = [];
		if (typeof event.duration_ms === 'number') parts.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
		if (typeof event.num_turns === 'number') parts.push(`${event.num_turns} turns`);
		if (typeof event.total_cost_usd === 'number') parts.push(`$${event.total_cost_usd.toFixed(4)}`);
		if (event.subtype && event.subtype !== 'success') parts.push(event.subtype);
		return parts.join(' · ');
	}
</script>

<div
	class="relative flex h-full min-h-0 flex-col"
	role="group"
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
>
	{#if !connected}
		<div
			class="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-warning px-3 py-1 text-xs font-medium text-warning-content"
		>
			reconnecting…
		</div>
	{/if}

	<div
		bind:this={scroller}
		onscroll={onScroll}
		class="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-3"
	>
		{#if !loaded}
			<div class="flex h-full items-center justify-center">
				<span class="loading loading-spinner loading-md opacity-50"></span>
			</div>
		{/if}
		{#if loadingOlder}
			<div class="flex justify-center py-1">
				<span class="loading loading-spinner loading-xs opacity-60"></span>
			</div>
		{/if}
		{#each visible as event, i (baseIndex + start + i)}
			{#if event.type === 'deck.user'}
				<div class="chat chat-end">
					<div class="chat-bubble max-w-[85%] break-words whitespace-pre-wrap bg-base-300 text-base-content">
						{#if event.images?.length}
							<div class="mb-2 flex flex-wrap gap-2">
								{#each event.images as img, k (k)}
									<img
										src={img.file ? `/api/sessions/${encodeURIComponent(session.id)}/images/${encodeURIComponent(img.file)}` : `data:${img.media_type};base64,${img.data}`}
										loading="lazy"
										alt="attachment"
										class="max-h-40 rounded-box border border-base-300"
									/>
								{/each}
							</div>
						{/if}
						{#if event.text}<Linked text={event.text} />{/if}
					</div>
				</div>
			{:else if event.type === 'deck.error'}
				<div class="alert alert-error py-2 text-sm break-words whitespace-pre-wrap">{event.text}</div>
			{:else if event.type === 'assistant'}
				{#each contentBlocks(event) as block, j (j)}
					{#if block.type === 'text' && block.text?.trim()}
						<div class="chat chat-start">
							<div class="chat-bubble max-w-[85%] break-words whitespace-pre-wrap bg-base-100 text-base-content">
								<Linked text={block.text} />
							</div>
						</div>
					{:else if block.type === 'thinking' && block.thinking?.trim()}
						<details class="px-2 text-xs opacity-50">
							<summary class="cursor-pointer select-none">
								<ChevronDown size={12} class="inline" /> thinking
							</summary>
							<pre class="break-words whitespace-pre-wrap pt-1">{block.thinking}</pre>
						</details>
					{:else if block.type === 'tool_use' && isAskTool(block)}
						<AskQuestion
							{block}
							answered={answeredQuestions.has(block.id)}
							answer={answeredQuestions.get(block.id)}
							onanswer={(text, answers) => answerQuestion(block.id, text, answers)}
						/>
					{:else if block.type === 'tool_use'}
						<ToolCall {block} result={resultsById.get(block.id)} />
					{/if}
				{/each}
			{:else if event.type === 'result'}
				<div class="px-2 text-center text-xs opacity-50">{fmtCost(event)}</div>
			{/if}
		{/each}

		{#if loaded && liveText.trim()}
			<div class="chat chat-start">
				<div class="chat-bubble max-w-[85%] break-words whitespace-pre-wrap bg-base-100 text-base-content">
					<Linked text={liveText} />
				</div>
			</div>
		{:else if loaded && status === 'running'}
			<div class="px-2 text-sm opacity-60">working...</div>
		{/if}
	</div>

	{#if dragging}
		<div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-box border-2 border-dashed border-primary bg-base-100/70 text-sm font-medium">
			Drop images to attach
		</div>
	{/if}

	{#if !atBottom}
		<button
			class="btn btn-circle btn-sm absolute bottom-28 left-1/2 -translate-x-1/2 border border-base-300"
			onclick={forceScroll}
			aria-label="Jump to latest"
		>
			<ArrowDown size={16} />
		</button>
	{/if}

	<div class="border-t border-base-300 bg-base-100 p-2 sm:p-3">
		{#if attachments.length}
			<div class="mb-2 flex flex-wrap gap-2">
				{#each attachments as a, i (i)}
					<div class="relative">
						<img src={a.url} alt="attachment" class="h-16 w-16 rounded-box border border-base-300 object-cover" />
						<button
							class="btn btn-circle btn-xs absolute -top-2 -right-2"
							onclick={() => removeAttachment(i)}
							aria-label="Remove attachment"
						>
							<X size={12} />
						</button>
					</div>
				{/each}
			</div>
		{/if}
		<div class="flex items-end gap-1.5 sm:gap-2">
			<input
				bind:this={fileInput}
				type="file"
				accept="image/*"
				multiple
				class="hidden"
				onchange={onPick}
			/>
			<button
				class="btn btn-ghost btn-square"
				onclick={() => fileInput?.click()}
				aria-label="Attach image"
				title="Attach image"
			>
				<Paperclip size={16} />
			</button>
			<textarea
				class="textarea min-h-12 flex-1"
				rows="2"
				placeholder={status === 'running'
					? 'queue a follow-up (ctrl/cmd+enter)'
					: 'message (ctrl/cmd+enter, paste images)'}
				bind:value={input}
				onkeydown={onKeydown}
				onpaste={onPaste}
			></textarea>
			{#if status === 'running'}
				<button class="btn btn-error" onclick={interrupt} aria-label="Interrupt">
					<Square size={16} /> <span class="hidden sm:inline">Interrupt</span>
				</button>
			{/if}
			<button class="btn btn-primary" onclick={send} disabled={!canSend} aria-label="Send">
				<Send size={16} /> <span class="hidden sm:inline">Send</span>
			</button>
		</div>
	</div>
</div>
