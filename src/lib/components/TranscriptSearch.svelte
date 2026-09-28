<script lang="ts">
	import { goto } from '$app/navigation';
	import { Search, User, Bot, MessageSquare, X } from '@lucide/svelte';
	import type { DeckSession } from '$lib/types';
	import type { NameMatch, SearchHit } from '$lib/search-core';
	import { MIN_QUERY_CHARS, matchSessionNames } from '$lib/search-core';
	import { searchUi } from '$lib/search-ui.svelte';
	import { relativeTime } from '$lib/time';

	// Search, leading with session names: most of the time you know which
	// session you want and you are trying to get to it. Those match as you type,
	// with no round trip. What was actually said still matches, under them, for
	// when a phrase is all you remember.

	type Row =
		| { kind: 'session'; id: string; title: string }
		| { kind: 'hit'; hit: SearchHit };

	let dialogEl = $state<HTMLDialogElement>();
	let inputEl = $state<HTMLInputElement>();
	let query = $state('');
	let sessions = $state<DeckSession[]>([]);
	let hits = $state<SearchHit[]>([]);
	let truncated = $state(false);
	let selected = $state(0);
	let busy = $state(false);
	let searched = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	// Names come from the session list, which is small and already recency
	// sorted, so matching is instant and needs no endpoint of its own.
	const names = $derived<NameMatch[]>(matchSessionNames(query, sessions));
	const rows = $derived<Row[]>([
		...names.map((m) => ({ kind: 'session' as const, id: m.id, title: m.title })),
		...hits.map((hit) => ({ kind: 'hit' as const, hit }))
	]);

	$effect(() => {
		if (searchUi.open) {
			dialogEl?.showModal();
			queueMicrotask(() => inputEl?.select());
			void loadSessions();
		} else {
			dialogEl?.close();
		}
	});

	async function loadSessions() {
		try {
			const res = await fetch('/api/sessions');
			if (res.ok) sessions = await res.json();
		} catch {
			// A failed list just means no name matches; the transcript search still runs.
		}
	}

	function close() {
		searchUi.open = false;
	}

	// Names are already showing by the time this fires; only the transcript scan
	// is worth debouncing.
	function onInput() {
		clearTimeout(timer);
		selected = 0;
		const q = query.trim();
		if (q.length < MIN_QUERY_CHARS) {
			hits = [];
			searched = '';
			return;
		}
		timer = setTimeout(() => void run(q), 250);
	}

	async function run(q: string) {
		busy = true;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=40`);
			if (!res.ok) return;
			const body = (await res.json()) as { hits: SearchHit[]; truncated: boolean };
			hits = body.hits;
			truncated = body.truncated;
			searched = q;
		} finally {
			busy = false;
		}
	}

	function open(row: Row) {
		close();
		const path =
			row.kind === 'session'
				? `/s/${encodeURIComponent(row.id)}`
				: `/s/${encodeURIComponent(row.hit.sessionId)}?at=${row.hit.index}`;
		void goto(path);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selected = Math.min(selected + 1, rows.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (e.key === 'Enter' && rows[selected]) {
			e.preventDefault();
			open(rows[selected]);
		}
	}
</script>

<dialog
	bind:this={dialogEl}
	class="modal"
	onclose={close}
	onclick={(e) => {
		if (e.target === dialogEl) close();
	}}
>
	<div class="modal-box flex max-h-[80vh] w-full max-w-2xl flex-col p-0" role="document">
		<label class="input flex w-full items-center gap-2 rounded-none border-0 border-b border-base-300 focus-within:outline-none">
			<Search size={16} class="shrink-0 opacity-60" />
			<input
				bind:this={inputEl}
				bind:value={query}
				oninput={onInput}
				onkeydown={onKeydown}
				class="grow"
				placeholder="Search sessions by name, or anything said"
				aria-label="Search sessions"
			/>
			{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
			<button class="btn btn-ghost btn-xs" onclick={close} aria-label="Close search"><X size={14} /></button>
		</label>
		<ul class="menu min-h-0 w-full flex-1 flex-nowrap overflow-y-auto p-1">
			{#if names.length}
				<li class="menu-title px-3 py-1 text-xs">Sessions</li>
			{/if}
			{#each rows as row, i (row.kind === 'session' ? `s:${row.id}` : `h:${row.hit.sessionId}:${row.hit.index}`)}
				{#if row.kind === 'hit' && i === names.length}
					<li class="menu-title px-3 py-1 text-xs">In what was said</li>
				{/if}
				<li>
					<button
						class="flex flex-col items-start gap-0.5 {i === selected ? 'active' : ''}"
						onclick={() => open(row)}
						onmouseenter={() => (selected = i)}
					>
						{#if row.kind === 'session'}
							<span class="flex w-full items-center gap-2">
								<MessageSquare size={13} class="shrink-0 opacity-60" />
								<span class="truncate font-medium">{row.title}</span>
							</span>
						{:else}
							<span class="flex w-full items-center gap-2 text-xs opacity-60">
								{#if row.hit.role === 'user'}<User size={12} />{:else}<Bot size={12} />{/if}
								<span class="truncate font-medium">{row.hit.title}</span>
								<span class="ml-auto shrink-0">{relativeTime(row.hit.at)}</span>
							</span>
							<span class="line-clamp-2 text-left text-sm">{row.hit.snippet}</span>
						{/if}
					</button>
				</li>
			{:else}
				<li class="px-3 py-6 text-center text-sm opacity-60">
					{#if query.trim().length >= MIN_QUERY_CHARS && searched}
						No session or message matches "{searched}".
					{:else if query.trim().length >= MIN_QUERY_CHARS}
						Searching…
					{:else}
						Type at least {MIN_QUERY_CHARS} characters.
					{/if}
				</li>
			{/each}
			{#if truncated}
				<li class="px-3 py-2 text-center text-xs opacity-60">More matches exist; narrow the search.</li>
			{/if}
		</ul>
	</div>
</dialog>
