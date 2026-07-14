<script lang="ts">
	import type { Project, PullRequest } from '$lib/types';
	import { relativeTime } from '$lib/time';
	import { runLoad } from '$lib/picker';
	import { RefreshCw, Check } from '@lucide/svelte';

	let {
		project,
		picked = [],
		onpick
	}: { project: Project; picked?: PullRequest[]; onpick: (pr: PullRequest) => void } = $props();

	// Multi-select mirrors IssuePicker: `onpick` toggles and the list stays open.
	// Selected rows show a check; the modal owns the array and renders chips.
	const prKey = (pr: PullRequest) => `${pr.sourceId}:${pr.number}`;
	const selectedKeys = $derived(new Set(picked.map(prKey)));

	type SourceError = { sourceId: string; message: string };

	let prs = $state<PullRequest[]>([]);
	let errors = $state<SourceError[]>([]);
	let loading = $state(false);
	let loadError = $state('');

	const hasGithub = $derived(!!project.sources?.some((s) => s.type === 'github'));

	// Guards a slow fetch for a previous project landing after a newer one.
	const seq = { n: 0 };

	function load(refresh = false) {
		if (!hasGithub) {
			// Bump the guard so an in-flight fetch for a previous (GitHub) project
			// can't land and repopulate the list after switching to a non-GitHub one.
			seq.n++;
			prs = [];
			errors = [];
			loadError = '';
			loading = false;
			return;
		}
		return runLoad<{ prs?: PullRequest[]; errors?: SourceError[] }>(
			`/api/prs?project=${encodeURIComponent(project.path)}${refresh ? '&refresh=1' : ''}`,
			seq,
			{
				loading: (v) => (loading = v),
				error: (m) => (loadError = m),
				ok: (d) => {
					prs = d.prs ?? [];
					errors = d.errors ?? [];
				}
			}
		);
	}

	// Reload whenever the bound project changes.
	$effect(() => {
		project.path;
		load();
	});
</script>

<div class="rounded-box border border-base-300 bg-base-200/40 p-2">
	<div class="mb-2 flex items-center gap-1">
		<span class="text-xs opacity-60">Review requested from you</span>
		<div class="flex-1"></div>
		<button
			class="btn btn-ghost btn-xs"
			onclick={() => load(true)}
			disabled={loading || !hasGithub}
			aria-label="Refresh"
		>
			<RefreshCw size={13} class={loading ? 'animate-spin' : ''} />
		</button>
	</div>

	{#if !hasGithub}
		<p class="p-4 text-center text-sm opacity-60">This project has no GitHub source.</p>
	{:else}
		{#if loadError}
			<div class="alert alert-error py-1 text-xs">{loadError}</div>
		{/if}
		{#each errors as e (e.sourceId)}
			<div class="alert alert-warning mb-1 py-1 text-xs">source error: {e.message}</div>
		{/each}

		<div class="max-h-64 overflow-y-auto">
			{#if loading && !prs.length}
				<p class="p-4 text-center text-sm opacity-60">Loading…</p>
			{:else if !prs.length}
				<p class="p-4 text-center text-sm opacity-60">No PRs awaiting your review.</p>
			{:else}
				{#each prs as pr (prKey(pr))}
					<button
						class="flex w-full items-center gap-2 border-b border-base-300 py-1.5 text-left last:border-0"
						onclick={() => onpick(pr)}
					>
						<span class="flex w-4 shrink-0 justify-center">
							{#if selectedKeys.has(prKey(pr))}<Check size={14} class="text-primary" />{/if}
						</span>
						<span class="shrink-0 font-mono text-xs opacity-70">#{pr.number}</span>
						<span class="min-w-0 flex-1 truncate text-sm">{pr.title}</span>
						{#if pr.isDraft}
							<span class="badge badge-ghost badge-sm shrink-0">draft</span>
						{/if}
						{#if pr.author}
							<span class="shrink-0 text-xs opacity-50">{pr.author}</span>
						{/if}
						<span class="shrink-0 text-xs opacity-50">{relativeTime(pr.updatedAt)}</span>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>
