<script lang="ts">
	import type { PageProps } from './$types';
	import type { DeckSession, NewSessionPreset, Project, ServerState } from '$lib/types';
	import ClaudeView from '$lib/components/ClaudeView.svelte';
	import ShellView from '$lib/components/ShellView.svelte';
	import DiffView from '$lib/components/DiffView.svelte';
	import DevServers from '$lib/components/DevServers.svelte';
	import ServerChip from '$lib/components/ServerChip.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import PrMenu from '$lib/components/PrMenu.svelte';
	import { shortPath } from '$lib/time';
	import { ISSUE_BADGE } from '$lib/issues';
	import { aggregateState } from '$lib/servers';
	import { ArrowLeft, Bot, Terminal, Menu, X, Ticket, TriangleAlert } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		clampSidebarWidth,
		parseSidebarWidth,
		SIDEBAR_DEFAULT,
		SIDEBAR_MIN,
		SIDEBAR_MAX
	} from '$lib/sidebar-width';

	let { data }: PageProps = $props();
	const session = $derived(data.session);

	let projects = $state<Project[]>([]);
	let sessions = $state<DeckSession[]>([]);
	let modalOpen = $state(false);
	let preset = $state<NewSessionPreset | null>(null);
	let sidebarOpen = $state(false);

	// The Changes tab (worktree diff). Shown only when the session's cwd is a git
	// repo. The badge count and the diff itself auto-refresh on turn end; the live
	// status comes from the existing /api/sessions poll, not a separate stream.
	let tab = $state<'main' | 'changes' | 'servers'>('main');
	let gitRepo = $state(false);
	let changedCount = $state<number | null>(null);
	const liveStatus = $derived(
		sessions.find((s) => s.id === session.id)?.status ?? session.status
	);

	// Captured PR link for the header chip/menu. Trust the polled session once it's
	// loaded (it reflects server truth, including a dismiss that cleared `pr`);
	// fall back to the page-load session only until the first poll lands. Mirrors
	// liveStatus, but `pr` can legitimately be undefined, so don't `??`-coalesce
	// back to the stale page-load value. Live state (colour, tally, mergeability)
	// is kept fresh by the background sync and surfaced through this poll, so the
	// chip needs no per-open fetch (issue #44).
	const livePr = $derived.by(() => {
		const live = sessions.find((s) => s.id === session.id);
		return live ? live.pr : session.pr;
	});

	// Dev-server states per session, from the monitor's cached poll (cheap), for
	// the header chip and the sidebar dots (issue #32). The Servers tab fetches
	// live per-server detail itself; its onStates keeps this fresh while open.
	let serverStates = $state<Record<string, ServerState[]>>({});
	const myServers = $derived(serverStates[session.id] ?? []);
	const serverChip = $derived(aggregateState(myServers));
	const hasServers = $derived(myServers.length > 0);

	async function refresh() {
		// allSettled, not all: a single endpoint failure (e.g. /api/servers) must not
		// abort the whole refresh and leave projects/sessions stale.
		const [pRes, sRes, vRes] = await Promise.allSettled([
			fetch('/api/projects'),
			fetch('/api/sessions'),
			fetch('/api/servers')
		]);
		if (pRes.status === 'fulfilled' && pRes.value.ok) projects = await pRes.value.json();
		if (sRes.status === 'fulfilled' && sRes.value.ok) sessions = await sRes.value.json();
		if (vRes.status === 'fulfilled' && vRes.value.ok) serverStates = await vRes.value.json();
	}

	$effect(() => {
		refresh();
		const interval = setInterval(refresh, 5000);
		return () => clearInterval(interval);
	});

	// Lightweight badge/visibility probe: meta only, no patch build.
	async function loadDiffMeta() {
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/diff?meta=1`);
			if (!res.ok) return;
			const data = await res.json();
			gitRepo = !!data.git;
			changedCount = data.git ? (data.meta?.fileCount ?? 0) : null;
			if (!gitRepo && tab === 'changes') tab = 'main';
		} catch {
			// transient failure: keep the previous badge state
		}
	}

	// Reset and re-probe when the viewed session changes.
	let metaLoadedFor = '';
	$effect(() => {
		if (metaLoadedFor === session.id) return;
		metaLoadedFor = session.id;
		tab = 'main';
		gitRepo = false;
		changedCount = null;
		void loadDiffMeta();
	});

	// Refresh the badge when a turn ends (running -> idle/error). When the Changes
	// tab is open, DiffView does its own running->idle refresh and reports the
	// count back via onCount, so skip the probe here to avoid doing the diff twice.
	let prevLive = ''; // last seen liveStatus, for the running -> idle edge
	$effect(() => {
		const s = liveStatus;
		if (prevLive === 'running' && s !== 'running' && tab !== 'changes') void loadDiffMeta();
		prevLive = s;
	});

	// Don't strand the Servers tab if its config is removed mid-session.
	$effect(() => {
		if (tab === 'servers' && !hasServers) tab = 'main';
	});

	function quickAdd(path: string) {
		preset = { projectPath: path };
		modalOpen = true;
		sidebarOpen = false;
	}
	function shellHere(s: DeckSession) {
		preset = { kind: 'shell', cwd: s.cwd, title: '' };
		modalOpen = true;
		sidebarOpen = false;
	}

	let delTarget = $state<DeckSession | null>(null);
	let delWorktree = $state(true);
	let delBranch = $state(true);
	// Deletes run in the background, so several can be in flight at once; track the
	// set of ids currently cleaning up rather than a single global lock (issue #59).
	const deletingIds = new SvelteSet<string>();
	let deleteError = $state<string | null>(null);

	function requestDelete(s: DeckSession) {
		if (deletingIds.has(s.id)) return;
		if (s.id === session.id) return; // never delete the active session
		if (s.worktree) {
			delWorktree = true;
			delBranch = s.worktree.createdBranch;
			delTarget = s;
			return;
		}
		if (!confirm(`Kill and remove "${s.title}"?`)) return;
		doDelete(s, {});
	}

	async function doDelete(
		s: DeckSession,
		opts: { deleteWorktree?: boolean; deleteBranch?: boolean }
	) {
		if (deletingIds.has(s.id)) return;
		delTarget = null; // close the confirm modal immediately; cleanup runs in the background
		deletingIds.add(s.id);
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(opts)
			});
			if (!res.ok) throw new Error(`delete failed: ${res.status}`);
			// Delete succeeded: clear any prior failure, then reconcile the list. A
			// refresh failure is transient (the 5s poll catches up) and must not be
			// reported as a delete failure.
			deleteError = null;
			try {
				await refresh();
			} catch {
				// ignore; the poll will drop the row
			}
		} catch {
			deleteError = `Couldn't remove "${s.title}".`;
		} finally {
			deletingIds.delete(s.id);
		}
	}

	// Resizable desktop sidebar (issue #52). SSR renders the default so it matches
	// the old lg:w-56; onMount hydrates the persisted width. The drag/keyboard math
	// lives in the node-free sidebar-width helper; persistence is best-effort.
	const SIDEBAR_WIDTH_KEY = 'deck:sidebar:width';
	let sidebarWidth = $state(SIDEBAR_DEFAULT);
	let resizing = $state(false);
	let dragStartX = 0; // pointer x at drag start
	let dragStartWidth = 0; // sidebar width at drag start

	onMount(() => {
		try {
			sidebarWidth = parseSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY));
		} catch {
			// storage disabled/blocked (private mode): keep the default width
		}
	});

	function persistWidth() {
		try {
			localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
		} catch {
			// non-critical: keep the in-memory width if the write fails
		}
	}

	function onHandleDown(e: PointerEvent) {
		if (e.button !== 0) return; // left button only
		resizing = true;
		dragStartX = e.clientX;
		dragStartWidth = sidebarWidth;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function onHandleMove(e: PointerEvent) {
		if (!resizing) return;
		// Track the pointer delta from drag start, not absolute x: the handle
		// overhangs the sidebar's right edge, so an absolute width would jump by
		// that overhang on the first move.
		sidebarWidth = clampSidebarWidth(dragStartWidth + (e.clientX - dragStartX));
	}

	// End a drag exactly once and persist. Reached via pointerup, pointercancel,
	// and lostpointercapture so a dropped capture can't strand `resizing` or lose
	// the final width; the `resizing` guard makes the extra calls no-ops.
	function endDrag() {
		if (!resizing) return;
		resizing = false;
		persistWidth();
	}

	function onHandleUp(e: PointerEvent) {
		// releasePointerCapture throws if the capture was already lost (endDrag also
		// runs via onlostpointercapture), so only release when we still hold it.
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
		endDrag();
	}

	function resetWidth() {
		sidebarWidth = SIDEBAR_DEFAULT;
		persistWidth();
	}

	function onHandleKey(e: KeyboardEvent) {
		const step = e.shiftKey ? 32 : 16;
		if (e.key === 'ArrowLeft') sidebarWidth = clampSidebarWidth(sidebarWidth - step);
		else if (e.key === 'ArrowRight') sidebarWidth = clampSidebarWidth(sidebarWidth + step);
		else if (e.key === 'Home') sidebarWidth = SIDEBAR_MIN;
		else if (e.key === 'End') sidebarWidth = SIDEBAR_MAX;
		else return;
		e.preventDefault();
		persistWidth();
	}
</script>

<svelte:head>
	<title>{session.title} · deck</title>
</svelte:head>

{#snippet sidebar()}
	<Sidebar
		{projects}
		{sessions}
		{serverStates}
		currentId={session.id}
		{deletingIds}
		onQuickAdd={quickAdd}
		onShellHere={shellHere}
		onDelete={requestDelete}
	/>
{/snippet}

<div class="flex h-full lg:gap-5" class:select-none={resizing} class:cursor-col-resize={resizing}>
	<div
		class="relative hidden h-full lg:block lg:shrink-0"
		style="width: {sidebarWidth}px"
	>
		<aside class="h-full overflow-y-auto">
			{@render sidebar()}
		</aside>
		<div
			role="slider"
			aria-label="Resize sidebar"
			aria-valuenow={sidebarWidth}
			aria-valuemin={SIDEBAR_MIN}
			aria-valuemax={SIDEBAR_MAX}
			aria-valuetext="{sidebarWidth} pixels"
			tabindex="0"
			class="group absolute inset-y-0 -right-3 w-3 cursor-col-resize touch-none"
			title="Drag to resize · double-click to reset"
			onpointerdown={onHandleDown}
			onpointermove={onHandleMove}
			onpointerup={onHandleUp}
			onpointercancel={endDrag}
			onlostpointercapture={endDrag}
			ondblclick={resetWidth}
			onkeydown={onHandleKey}
		>
			<div
				class="mx-auto h-full w-px transition-colors {resizing
					? 'bg-primary'
					: 'bg-base-300 group-hover:bg-primary group-focus-visible:bg-primary'}"
			></div>
		</div>
	</div>

	<div class="flex h-full min-w-0 flex-1 flex-col">
		{#if deleteError}
			<div class="alert alert-error mb-2 py-2 text-sm" role="alert">
				<span class="flex-1 break-words">{deleteError}</span>
				<button
					class="btn btn-ghost btn-xs"
					onclick={() => (deleteError = null)}
					aria-label="Dismiss error"
				>
					<X size={14} />
				</button>
			</div>
		{/if}
		<div class="mb-2 flex items-center gap-2">
			<a href="/" class="btn btn-ghost btn-sm shrink-0" aria-label="Back">
				<ArrowLeft size={16} />
			</a>
			<button
				class="btn btn-ghost btn-sm shrink-0 lg:hidden"
				onclick={() => (sidebarOpen = true)}
				aria-label="Open sessions"
			>
				<Menu size={16} />
			</button>
			{#if session.kind === 'shell'}
				<Terminal size={16} class="shrink-0 opacity-70" />
			{:else}
				<Bot size={16} class="shrink-0 opacity-70" />
			{/if}
			{#if session.kind !== 'claude' && session.kind !== 'shell'}
				<span class="badge badge-ghost badge-sm shrink-0">{session.kind}</span>
			{/if}
			<div class="flex min-w-0 flex-1 items-baseline gap-2">
				<span class="truncate font-medium">{session.title}</span>
				{#if session.issue}
					{#if session.issue.url}
						<a
							href={session.issue.url}
							target="_blank"
							rel="noopener noreferrer"
							class="badge badge-outline badge-sm link link-hover shrink-0 gap-1"
							title="{ISSUE_BADGE[session.issue.source].label} {session.issue.id}"
						>
							<Ticket size={12} />
							<span class="hidden sm:inline"
								>{ISSUE_BADGE[session.issue.source].label} {session.issue.id}</span
							>
						</a>
					{:else}
						<span
							class="badge badge-outline badge-sm shrink-0 gap-1"
							title="{ISSUE_BADGE[session.issue.source].label} {session.issue.id}"
						>
							<Ticket size={12} />
							<span class="hidden sm:inline"
								>{ISSUE_BADGE[session.issue.source].label} {session.issue.id}</span
							>
						</span>
					{/if}
				{/if}
				{#if livePr}
					<PrMenu id={session.id} pr={livePr} onChange={refresh} />
				{/if}
				<span class="hidden truncate text-xs opacity-60 sm:inline">{shortPath(session.cwd)}</span>
			</div>
			{#if serverChip}
				<ServerChip state={serverChip} count={myServers.length} />
			{/if}
			{#if session.kind === 'claude' && session.permissionMode === 'bypassPermissions'}
				<span class="badge badge-outline badge-sm shrink-0 gap-1" title="yolo (bypassPermissions)">
					<TriangleAlert size={12} class="sm:hidden" />
					<span class="hidden sm:inline">yolo</span>
				</span>
			{/if}
		</div>

		{#if gitRepo || hasServers}
			<div class="join mb-2 shrink-0 self-start">
				<button
					class="btn join-item btn-sm {tab === 'main' ? 'btn-active' : 'btn-ghost'}"
					onclick={() => (tab = 'main')}
					aria-pressed={tab === 'main'}
				>
					{session.kind === 'shell' ? 'Terminal' : 'Chat'}
				</button>
				{#if gitRepo}
					<button
						class="btn join-item btn-sm gap-1 {tab === 'changes' ? 'btn-active' : 'btn-ghost'}"
						onclick={() => (tab = 'changes')}
						aria-pressed={tab === 'changes'}
					>
						Changes
						{#if changedCount}<span class="badge badge-neutral badge-sm">{changedCount}</span>{/if}
					</button>
				{/if}
				{#if hasServers}
					<button
						class="btn join-item btn-sm gap-1 {tab === 'servers' ? 'btn-active' : 'btn-ghost'}"
						onclick={() => (tab = 'servers')}
						aria-pressed={tab === 'servers'}
					>
						Servers
						<span class="badge badge-neutral badge-sm">{myServers.length}</span>
					</button>
				{/if}
			</div>
		{/if}

		<div class="min-h-0 flex-1">
			<div class="h-full" class:hidden={tab !== 'main'}>
				{#if session.kind === 'shell'}
					<ShellView {session} />
				{:else}
					<ClaudeView {session} />
				{/if}
			</div>
			{#if tab === 'changes'}
				<DiffView
					{session}
					{liveStatus}
					onCount={(n) => {
						if (n !== null) changedCount = n;
					}}
				/>
			{/if}
			{#if tab === 'servers'}
				<DevServers
					{session}
					onStates={(states) => (serverStates = { ...serverStates, [session.id]: states })}
				/>
			{/if}
		</div>
	</div>
</div>

{#if sidebarOpen}
	<div class="fixed inset-0 z-40 lg:hidden">
		<button
			class="absolute inset-0 bg-black/40"
			onclick={() => (sidebarOpen = false)}
			aria-label="Close sessions"
		></button>
		<div
			class="absolute inset-y-0 left-0 w-72 max-w-[80%] overflow-y-auto border-r border-base-300 bg-base-100 p-3"
		>
			<div class="mb-2 flex justify-end">
				<button class="btn btn-ghost btn-sm" onclick={() => (sidebarOpen = false)} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			{@render sidebar()}
		</div>
	</div>
{/if}

<NewSessionModal bind:open={modalOpen} {preset} />

{#if delTarget}
	<div class="modal modal-open" role="dialog">
		<div class="modal-box max-w-sm">
			<h3 class="mb-2 text-lg font-semibold">Remove "{delTarget.title}"</h3>
			<p class="mb-3 text-sm opacity-70">
				Kills the session. This session lives in a git worktree on branch
				<span class="font-mono">{delTarget.worktree?.branch}</span>.
			</p>
			<div class="space-y-2">
				<label class="label cursor-pointer justify-start gap-2">
					<input type="checkbox" class="checkbox checkbox-sm" bind:checked={delWorktree} />
					<span>Delete the worktree</span>
				</label>
				<label class="label cursor-pointer justify-start gap-2">
					<input
						type="checkbox"
						class="checkbox checkbox-sm"
						bind:checked={delBranch}
						disabled={!delWorktree || !delTarget.worktree?.createdBranch}
					/>
					<span>
						Delete the branch
						{#if !delTarget.worktree?.createdBranch}
							<span class="opacity-50">(existing branch, kept)</span>
						{/if}
					</span>
				</label>
			</div>
			<div class="modal-action">
				<button class="btn" onclick={() => (delTarget = null)}>Cancel</button>
				<button
					class="btn btn-error"
					onclick={() =>
						delTarget &&
						doDelete(delTarget, { deleteWorktree: delWorktree, deleteBranch: delBranch })}
				>
					Remove
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (delTarget = null)} aria-label="close"></button>
	</div>
{/if}
