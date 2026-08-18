<script lang="ts">
	import type { DeckSession, NewSessionPreset, Project, SessionKind } from '$lib/types';
	import { relativeTime, shortPath } from '$lib/time';
	import { groupSessions } from '$lib/groups';
	import { bucketSessions, BUCKET_DOT } from '$lib/status-groups';
	import { viewMode } from '$lib/view-mode.svelte';
	import { viewModeLabel } from '$lib/view-mode';
	import { createCollapseState } from '$lib/collapse.svelte';
	import { DeleteFlow } from '$lib/delete-flow.svelte';
	import { flattenVisibleBuckets, flattenVisibleGroups } from '$lib/sidebar-neighbor';
	import { allSelected, rangeIds, staleIds } from '$lib/session-select';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import DeleteSessionModal from '$lib/components/DeleteSessionModal.svelte';
	import QrModal from '$lib/components/QrModal.svelte';
	import PairApprovals, { type PendingPairing } from '$lib/components/PairApprovals.svelte';
	import { Bot, Terminal, Plus, Trash2, RefreshCw, FolderGit2, FolderTree, Activity, FolderCog, QrCode, ChevronRight, ChevronDown, X, Square, SquareCheckBig } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	let sessions = $state<DeckSession[]>([]);
	let projects = $state<Project[]>([]);
	let filter = $state<'all' | SessionKind>('all');
	let modalOpen = $state(false);
	let preset = $state<NewSessionPreset | null>(null);
	let loaded = $state(false);
	let qrOpen = $state(false);
	let pending = $state<PendingPairing[]>([]);

	// Multi-select for batch removal (issue #211). `anchor` is the last row clicked
	// in select mode, which a shift-click extends the range from.
	let selectMode = $state(false);
	const selected = new SvelteSet<string>();
	let anchor: string | null = null;

	function openNew() {
		preset = null;
		modalOpen = true;
	}

	// The palette's "New session" navigates here with ?new=1; open the modal and
	// drop the flag so a reload or back-nav doesn't reopen it.
	$effect(() => {
		if (page.url.searchParams.has('new')) {
			openNew();
			goto('/', { replaceState: true, keepFocus: true, noScroll: true });
		}
	});

	function quickAdd(path: string) {
		preset = projects.some((p) => p.path === path) ? { projectPath: path } : { cwd: path };
		modalOpen = true;
	}

	async function refresh() {
		const [sRes, pRes, pairRes] = await Promise.all([
			fetch('/api/sessions'),
			fetch('/api/projects'),
			fetch('/api/pair/pending')
		]);
		if (sRes.ok) sessions = await sRes.json();
		if (pRes.ok) projects = await pRes.json();
		if (pairRes.ok) pending = (await pairRes.json()).pending;
		loaded = true;
	}

	$effect(() => {
		refresh();
		const interval = setInterval(refresh, 5000);
		return () => clearInterval(interval);
	});

	const visible = $derived(filter === 'all' ? sessions : sessions.filter((s) => s.kind === filter));

	// Only surface filter buttons for kinds that actually have sessions.
	const filterKinds = $derived(
		(['claude', 'pi', 'codex', 'opencode', 'shell'] as SessionKind[]).filter((k) =>
			sessions.some((s) => s.kind === k)
		)
	);

	// Two-level grouping: project-group -> per-project subgroup -> sessions (issue #34).
	const groups = $derived(groupSessions(visible, projects));

	// Attention-first buckets cutting across projects, for the "By status" view;
	// the same derivation the sidebar renders (issue #206).
	const buckets = $derived(bucketSessions(visible));

	// Collapse state for the project view, default-collapsed and persisted
	// independently from the sidebar's (no auto-expand).
	const collapse = createCollapseState('deck:home:expandedGroups');

	// Status buckets default *expanded*, so this set tracks the collapsed ones.
	const statusCollapse = createCollapseState('deck:home:collapsedStatusBuckets');

	// Select mode ends the moment a confirmed batch starts, before the first request
	// goes out, and the progress readout takes the action bar's place. Cancelling the
	// confirm never gets here, so the selection survives it.
	const del = new DeleteFlow(refresh, () => {}, exitSelect);

	// The sessions in the order the current view actually renders them, collapsed
	// sections contributing nothing. This is what Select All covers and what a
	// shift-click range walks, so a range follows the rows on screen rather than the
	// raw list. Reuses the sidebar's flatteners; note the project view tracks
	// expanded groups while the status view tracks collapsed buckets.
	const visibleOrder = $derived(
		viewMode.current === 'status'
			? flattenVisibleBuckets(buckets, (k) => statusCollapse.has(k))
			: flattenVisibleGroups(groups, (n) => collapse.has(n))
	);

	// Keep the selection to rows that are actually on the list: the 5s poll can
	// remove a session under it, and switching the kind filter can hide one, either
	// of which would otherwise leave a stale id in the Remove count and in the batch.
	// Leave select mode outright once there's nothing left to select.
	$effect(() => {
		for (const id of staleIds(selected, visible)) selected.delete(id);
		if (visible.length === 0) exitSelect();
	});

	function exitSelect() {
		selectMode = false;
		selected.clear();
		anchor = null;
	}

	function toggleSelect(id: string, shift: boolean) {
		const range = shift && anchor && anchor !== id ? rangeIds(visibleOrder, anchor, id) : [];
		if (range.length > 0) {
			for (const rid of range) selected.add(rid);
		} else if (selected.has(id)) {
			selected.delete(id);
		} else {
			selected.add(id);
		}
		anchor = id;
	}

	// Select All covers exactly the rows on screen; Deselect All clears the lot, so a
	// row hidden inside a collapsed section can't linger in the count.
	function toggleAll() {
		if (allSelected(visibleOrder, selected)) selected.clear();
		else for (const s of visibleOrder) selected.add(s.id);
		anchor = null;
	}

	function removeSelected() {
		del.requestBatch(sessions.filter((s) => selected.has(s.id)));
	}

	// Escape leaves select mode, but not from under anything else that owns the key:
	// this page's div-modals (which would be stranded over a list that's no longer
	// selecting) and the command palette, a native <dialog> whose own Escape neither
	// marks the event handled nor stops it bubbling up here.
	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.defaultPrevented) return;
		if (!selectMode || modalOpen || qrOpen || del.target || del.batch) return;
		if (document.querySelector('dialog[open]')) return;
		exitSelect();
	}

	// Status as a quiet dot + label. Saturated colour is reserved for the states
	// that want attention (running = brand orange, error = red); idle and dead stay
	// neutral so a list at rest reads calm. Solid vs hollow keeps idle and dead
	// apart under e-ink, where colour collapses to monochrome.
	function statusDot(s: DeckSession) {
		if (s.status === 'running') return 'bg-primary';
		if (s.status === 'error') return 'bg-error';
		if (s.status === 'dead') return 'border border-base-content/40';
		return 'bg-base-content/35';
	}
	function statusText(s: DeckSession) {
		if (s.status === 'running') return 'font-medium text-primary';
		if (s.status === 'error') return 'font-medium text-error';
		if (s.status === 'dead') return 'text-base-content/40';
		return 'text-base-content/55';
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
	<div class="flex items-center gap-2">
		<div class="join">
			{#each ['all', ...filterKinds] as f (f)}
				<button
					class="btn join-item btn-sm {filter === f ? 'btn-active' : ''}"
					onclick={() => (filter = f as 'all' | SessionKind)}
				>
					{f}
				</button>
			{/each}
		</div>
		<button
			class="btn btn-ghost btn-sm"
			onclick={viewMode.toggle}
			title={viewModeLabel(viewMode.current)}
			aria-label={viewModeLabel(viewMode.current)}
		>
			{#if viewMode.current === 'project'}<Activity size={16} />{:else}<FolderTree size={16} />{/if}
		</button>
	</div>
	<div class="flex items-center gap-2">
		<a href="/projects" class="btn btn-ghost btn-sm" aria-label="Manage projects" title="Projects">
			<FolderCog size={16} />
		</a>
		<button
			class="btn btn-ghost btn-sm"
			onclick={() => (qrOpen = true)}
			aria-label="Sign in another device"
			title="Sign in another device"
		>
			<QrCode size={16} />
		</button>
		<button class="btn btn-ghost btn-sm" onclick={refresh} aria-label="Refresh">
			<RefreshCw size={16} />
		</button>
		{#if sessions.length > 0}
			<button
				class="btn btn-ghost btn-sm"
				onclick={() => (selectMode ? exitSelect() : (selectMode = true))}
				disabled={!!del.progress}
			>
				{selectMode ? 'Done' : 'Select'}
			</button>
		{/if}
		<button class="btn btn-sm btn-primary" onclick={openNew}>
			<Plus size={16} /> New
		</button>
	</div>
</div>

<PairApprovals {pending} onchange={refresh} />

{#snippet row(s: DeckSession)}
	{@const picked = selected.has(s.id)}
	<div
		class="flex items-center gap-2 rounded-box border bg-base-100 pr-2 hover:border-base-content/30 sm:gap-3 sm:pr-3 {selectMode
			? 'select-none'
			: ''} {selectMode && picked ? 'border-primary' : 'border-base-300'}"
	>
		<a
			href={`/s/${encodeURIComponent(s.id)}`}
			class="flex min-w-0 flex-1 items-center gap-2 py-3 pl-3 sm:gap-3 sm:pl-4"
			role={selectMode ? 'checkbox' : undefined}
			aria-checked={selectMode ? picked : undefined}
			onclick={(e) => {
				if (!selectMode) return;
				e.preventDefault();
				toggleSelect(s.id, e.shiftKey);
			}}
		>
			{#if selectMode}
				{#if picked}
					<SquareCheckBig size={18} class="shrink-0 text-primary" />
				{:else}
					<Square size={18} class="shrink-0 opacity-50" />
				{/if}
			{:else if s.kind === 'shell'}
				<Terminal size={18} class="shrink-0 opacity-70" />
			{:else}
				<Bot size={18} class="shrink-0 opacity-70" />
			{/if}
			<div class="min-w-0 flex-1">
				<div class="truncate font-medium">{s.title}</div>
				<div class="truncate text-xs opacity-60">{shortPath(s.cwd)}</div>
			</div>
			{#if s.kind === 'pi' || s.kind === 'codex' || s.kind === 'opencode'}
				<span class="badge badge-ghost badge-sm">{s.kind}</span>
			{/if}
			{#if s.kind === 'shell' && s.attached}
				<span class="badge badge-outline badge-sm">attached</span>
			{/if}
			{#if s.managed === false}
				<span class="badge badge-ghost badge-sm">adhoc</span>
			{/if}
			<span class="flex shrink-0 items-center gap-1.5">
				<span class="size-2 shrink-0 rounded-full {statusDot(s)}"></span>
				<span class="text-xs {statusText(s)}">{s.status}</span>
			</span>
			<span class="w-10 text-right text-xs tabular-nums opacity-60">{relativeTime(s.lastActiveAt)}</span>
		</a>
		<button
			class="btn btn-ghost btn-xs"
			onclick={() => del.request(s)}
			disabled={del.deletingIds.has(s.id)}
			aria-label={`Remove ${s.title}`}
		>
			{#if del.deletingIds.has(s.id)}
				<span class="loading loading-spinner loading-xs"></span>
			{:else}
				<Trash2 size={14} />
			{/if}
		</button>
	</div>
{/snippet}

{#if del.error}
	<div class="alert alert-error mb-3 py-2 text-sm" role="alert">
		<span class="flex-1 break-words">{del.error}</span>
		<button
			class="btn btn-ghost btn-xs"
			onclick={() => (del.error = null)}
			aria-label="Dismiss error"
		>
			<X size={14} />
		</button>
	</div>
{/if}

{#if del.progress}
	{@const p = del.progress}
	<div class="mb-3 rounded-box border border-base-300 bg-base-100 px-3 py-2">
		<div class="mb-1.5 text-sm">
			{p.total === 1 ? 'Removing session' : `Removing ${Math.min(p.done + 1, p.total)} of ${p.total}`}
		</div>
		<progress class="progress w-full progress-primary" value={p.done} max={p.total}></progress>
	</div>
{:else if selectMode}
	<div
		class="mb-3 flex flex-wrap items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2"
	>
		<button class="btn btn-ghost btn-sm" onclick={toggleAll} disabled={visibleOrder.length === 0}>
			{allSelected(visibleOrder, selected) ? 'Deselect All' : 'Select All'}
		</button>
		<span class="text-sm opacity-60">{selected.size} selected</span>
		<button
			class="btn ml-auto btn-error btn-sm"
			onclick={removeSelected}
			disabled={selected.size === 0}
		>
			<Trash2 size={14} /> Remove ({selected.size})
		</button>
	</div>
{/if}

{#if !loaded}
	<p class="p-8 text-center opacity-60">Loading sessions...</p>
{:else if visible.length === 0}
	<div class="rounded-box border border-base-300 bg-base-100 p-10 text-center">
		<p class="mb-3 opacity-70">No sessions yet.</p>
		<button class="btn btn-primary btn-sm" onclick={openNew}>
			<Plus size={16} /> New session
		</button>
	</div>
{:else if viewMode.current === 'status'}
	<div class="space-y-4">
		{#each buckets as bucket (bucket.key)}
			{@const isOpen = !statusCollapse.has(bucket.key)}
			<section>
				<button
					class="flex w-full items-center gap-2 rounded-btn px-1 py-1 text-left hover:bg-base-200"
					onclick={() => statusCollapse.toggle(bucket.key)}
					aria-expanded={isOpen}
				>
					{#if isOpen}
						<ChevronDown size={16} class="shrink-0 opacity-60" />
					{:else}
						<ChevronRight size={16} class="shrink-0 opacity-60" />
					{/if}
					<span class="size-2 shrink-0 rounded-full {BUCKET_DOT[bucket.key]}"></span>
					<span class="font-semibold {bucket.key === 'needs-attention' ? 'text-error' : ''}">
						{bucket.label}
					</span>
					<span class="text-xs opacity-50">{bucket.sessions.length}</span>
				</button>
				{#if isOpen}
					<ul class="mt-2 space-y-2 pl-4">
						{#each bucket.sessions as s (s.id)}
							<li>{@render row(s)}</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/each}
	</div>
{:else}
	<div class="space-y-4">
		{#each groups as group (group.name)}
			{@const isOpen = collapse.has(group.name)}
			<section>
				<button
					class="flex w-full items-center gap-2 rounded-btn px-1 py-1 text-left hover:bg-base-200"
					onclick={() => collapse.toggle(group.name)}
					aria-expanded={isOpen}
				>
					{#if isOpen}
						<ChevronDown size={16} class="shrink-0 opacity-60" />
					{:else}
						<ChevronRight size={16} class="shrink-0 opacity-60" />
					{/if}
					<span class="font-semibold">{group.name}</span>
					<span class="text-xs opacity-50">{group.sessionCount}</span>
				</button>
				{#if isOpen}
					<div class="mt-2 space-y-5 pl-4">
						{#each group.subgroups as g (g.key)}
							<section>
								<div class="mb-1.5 flex items-center gap-2 px-1">
									<FolderGit2 size={14} class="shrink-0 opacity-50" />
									<h2 class="font-semibold">{g.label}</h2>
									<span class="text-xs opacity-50">{g.sessions.length}</span>
									<span class="min-w-0 truncate text-xs opacity-40">{shortPath(g.key)}</span>
									<button
										class="btn btn-ghost btn-xs ml-auto shrink-0"
										onclick={() => quickAdd(g.key)}
										aria-label={`New session in ${g.label}`}
										title="New session here"
									>
										<Plus size={15} class="text-primary" />
									</button>
								</div>
								<ul class="space-y-2">
									{#each g.sessions as s (s.id)}
										<li>{@render row(s)}</li>
									{/each}
								</ul>
							</section>
						{/each}
					</div>
				{/if}
			</section>
		{/each}
	</div>
{/if}

<NewSessionModal bind:open={modalOpen} {preset} />

<QrModal bind:open={qrOpen} />

<DeleteSessionModal flow={del} />
