<script lang="ts">
	// What needs you: every ask waiting on an answer and every blocked workflow
	// run, from GET /api/agent/asks, answered in place. The list refetches when
	// the event feed reports an ask or run change rather than on a timer.
	import { sessionFeed } from '$lib/session-feed.svelte';
	import { answerRequest, askBlock, inboxGroups, touchesInbox, type AnswerPick, type InboxAsk, type InboxRow } from '$lib/inbox-core';
	import { api } from '$lib/workflow-view';
	import { relativeTime } from '$lib/time';
	import AskQuestion from '$lib/components/AskQuestion.svelte';
	import { ExternalLink, Inbox } from '@lucide/svelte';

	let asks = $state<InboxAsk[]>([]);
	let loaded = $state(false);
	let loadError = $state('');
	let rowErrors = $state<Record<string, string>>({});
	let generation = 0;

	const feed = sessionFeed((res) => {
		if (touchesInbox(res)) void load();
	});
	const groups = $derived(inboxGroups(asks, feed.sessions));

	// A later load supersedes one still in flight, so a slow reply can't bring
	// back an ask that has since been answered.
	async function load() {
		const n = ++generation;
		try {
			const next = await api<InboxAsk[]>('/api/agent/asks');
			if (n !== generation) return;
			asks = next;
			loadError = '';
		} catch (e) {
			if (n === generation) loadError = e instanceof Error ? e.message : "Couldn't load the inbox";
		}
		loaded = true;
	}

	async function answer(row: InboxRow, text: string, picks: AnswerPick[]) {
		const { url, body } = answerRequest(row.ask, text, picks);
		try {
			// ok:false means nothing was waiting any more: answered elsewhere.
			await api(url, 'POST', body);
			asks = asks.filter((a) => a !== row.ask);
		} catch (e) {
			rowErrors[row.key] = e instanceof Error ? e.message : "Couldn't send the answer";
		}
		void load();
	}
</script>

<svelte:head><title>Inbox · deck</title></svelte:head>

<div>
	<div class="mb-4 flex items-center gap-2">
		<h1 class="text-lg font-semibold">Inbox</h1>
	</div>

	{#if loadError}
		<div class="alert alert-error mb-4 py-2 text-sm">{loadError}</div>
	{/if}

	{#if !loaded}
		<div class="flex justify-center py-12"><span class="loading loading-spinner"></span></div>
	{:else if groups.length === 0}
		<div class="flex flex-col items-center gap-2 py-16 text-center opacity-60">
			<Inbox size={28} />
			<p>Nothing needs you</p>
		</div>
	{:else}
		{#each groups as group (group.id)}
			<section class="mb-6">
				<h2 class="mb-2 text-xs font-semibold tracking-wide uppercase opacity-60">{group.label}</h2>
				<ul class="space-y-3">
					{#each group.rows as row (row.key)}
						<li>
							<div class="mb-1 flex items-center gap-2 px-1 text-sm">
								<a href={row.href} class="link-hover flex min-w-0 items-center gap-1 font-medium">
									<span class="truncate">{row.title}</span>
									<ExternalLink size={12} class="shrink-0 opacity-60" />
								</a>
								<span class="text-xs opacity-60">{row.subtitle}</span>
								<span class="ml-auto shrink-0 text-xs opacity-60">{relativeTime(row.ask.askedAt)}</span>
							</div>
							<AskQuestion
								block={askBlock(row.ask)}
								title={row.ask.source === 'run' ? 'The run is blocked' : 'Asking you'}
								onanswer={(text, picks) => answer(row, text, picks)}
							/>
							{#if rowErrors[row.key]}
								<p class="mt-1 px-1 text-xs text-error">{rowErrors[row.key]}</p>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
</div>
