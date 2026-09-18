<script lang="ts">
	import { goto } from '$app/navigation';
	import { Search, User, Bot, X } from '@lucide/svelte';
	import type { SearchHit } from '$lib/search-core';
	import { MIN_QUERY_CHARS } from '$lib/search-core';
	import { searchUi } from '$lib/search-ui.svelte';
	import { relativeTime } from '$lib/time';

	// Full-text search over every session's transcript (what you said and what
	// the agent said). A hit opens its session scrolled to that message.

	let dialogEl = $state<HTMLDialogElement>();
	let inputEl = $state<HTMLInputElement>();
	let query = $state('');
	let hits = $state<SearchHit[]>([]);
	let truncated = $state(false);
	let selected = $state(0);
	let busy = $state(false);
	let searched = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (searchUi.open) {
			dialogEl?.showModal();
			queueMicrotask(() => inputEl?.select());
		} else {
			dialogEl?.close();
		}
	});

	function close() {
		searchUi.open = false;
	}

	// Debounced so typing doesn't fire a scan per keystroke.
	function onInput() {
		clearTimeout(timer);
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
			selected = 0;
		} finally {
			busy = false;
		}
	}

	function open(hit: SearchHit) {
		close();
		void goto(`/s/${encodeURIComponent(hit.sessionId)}?at=${hit.index}`);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selected = Math.min(selected + 1, hits.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (e.key === 'Enter' && hits[selected]) {
			e.preventDefault();
			open(hits[selected]);
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
				placeholder="Search everything said in every session"
				aria-label="Search transcripts"
			/>
			{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
			<button class="btn btn-ghost btn-xs" onclick={close} aria-label="Close search"><X size={14} /></button>
		</label>
		<ul class="menu min-h-0 w-full flex-1 flex-nowrap overflow-y-auto p-1">
			{#each hits as hit, i (`${hit.sessionId}:${hit.index}`)}
				<li>
					<button
						class="flex flex-col items-start gap-0.5 {i === selected ? 'active' : ''}"
						onclick={() => open(hit)}
						onmouseenter={() => (selected = i)}
					>
						<span class="flex w-full items-center gap-2 text-xs opacity-60">
							{#if hit.role === 'user'}<User size={12} />{:else}<Bot size={12} />{/if}
							<span class="truncate font-medium">{hit.title}</span>
							<span class="ml-auto shrink-0">{relativeTime(hit.at)}</span>
						</span>
						<span class="line-clamp-2 text-left text-sm">{hit.snippet}</span>
					</button>
				</li>
			{:else}
				<li class="px-3 py-6 text-center text-sm opacity-60">
					{#if searched}No matches for "{searched}".{:else}Type at least {MIN_QUERY_CHARS} characters.{/if}
				</li>
			{/each}
			{#if truncated}
				<li class="px-3 py-2 text-center text-xs opacity-60">More matches exist; narrow the search.</li>
			{/if}
		</ul>
	</div>
</dialog>
