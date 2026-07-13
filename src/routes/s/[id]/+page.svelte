<script lang="ts">
	import type { PageProps } from './$types';
	import type { DeckSession, NewSessionPreset, Project, ServerState } from '$lib/types';
	import ClaudeView from '$lib/components/ClaudeView.svelte';
	import ShellView from '$lib/components/ShellView.svelte';
	import DiffView from '$lib/components/DiffView.svelte';
	import DevServers from '$lib/components/DevServers.svelte';
	import ServerChip from '$lib/components/ServerChip.svelte';
	import RunButton from '$lib/components/RunButton.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import PrMenu from '$lib/components/PrMenu.svelte';
	import IssueMenu from '$lib/components/IssueMenu.svelte';
	import ModelMenu from '$lib/components/ModelMenu.svelte';
	import WorkflowMenu from '$lib/components/WorkflowMenu.svelte';
	import WorkflowProgress from '$lib/components/WorkflowProgress.svelte';
	import { shortPath } from '$lib/time';
	import { ISSUE_BADGE } from '$lib/issues';
	import { aggregateState } from '$lib/servers';
	import DeleteSessionModal from '$lib/components/DeleteSessionModal.svelte';
	import { DeleteFlow, requestDelete } from '$lib/delete-flow.svelte';
	import { goto } from '$app/navigation';
	import { Menu, X, Ticket } from '@lucide/svelte';
	import { onMount } from 'svelte';
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

	// One chip per attached issue. New sessions store `issues`; older ones only
	// the single `issue`, so read them together.
	const issueChips = $derived(session.issues ?? (session.issue ? [session.issue] : []));

	// Current model for the header switcher. Like livePr, trust the polled session
	// once loaded (a switch persists server-side); the model can legitimately be
	// undefined, so don't ??-coalesce back to the page-load value.
	const liveModel = $derived.by(() => {
		const live = sessions.find((s) => s.id === session.id);
		return live ? live.model : session.model;
	});

	// Workflow run state for the progress strip. Same trust order as livePr:
	// the polled session once loaded (it reflects cancel/step transitions), the
	// page-load session until then. `workflowRun` can legitimately be undefined
	// after a dismiss, so don't ??-coalesce back to the page-load value.
	const liveRun = $derived.by(() => {
		const live = sessions.find((s) => s.id === session.id);
		return live ? live.workflowRun : session.workflowRun;
	});
	const runActive = $derived(
		liveRun?.status === 'running' || liveRun?.status === 'awaiting-input'
	);

	// The registered project this session belongs to (directly, or via the
	// worktree it was created from), for the run-workflow menu. Only configured
	// workflows are offered; the legacy synthesized pair isn't a run. Longest
	// matching path wins so a nested project isn't shadowed by its parent.
	const sessionProject = $derived(
		projects.find((p) => p.path === session.worktree?.repo) ??
			projects
				.filter(
					(p) =>
						session.cwd === p.path ||
						session.cwd.startsWith(`${p.path}/`) ||
						session.cwd.startsWith(`${p.path}-worktrees/`)
				)
				.sort((a, b) => b.path.length - a.path.length)[0]
	);
	const sessionWorkflows = $derived(sessionProject?.workflows ?? []);

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

	// Where to go when the open session's own delete fires: its visible sidebar
	// neighbour, or home if it was the only session. The Sidebar owns the on-screen
	// order, so it computes this at click time and hands it to onDeleteSession.
	let pendingHref = '/';

	// Deleting the open session tears down this page, so jump to its neighbour once
	// the delete lands (replaceState so Back doesn't reopen the now-gone session);
	// deleting any other row is unchanged.
	const del = new DeleteFlow(refresh, (s) => {
		if (s.id === session.id) goto(pendingHref, { replaceState: true });
	});
	function onDeleteSession(s: DeckSession, neighbor?: DeckSession | null) {
		if (s.id === session.id) pendingHref = neighbor ? `/s/${encodeURIComponent(neighbor.id)}` : '/';
		del.request(s);
	}

	// PrMenu merged the PR and asked to also tear down the local footprint (issue
	// #116). Remove the worktree and session (and the local branch when deck
	// created it) in the background, then leave for home so cleanup doesn't block
	// the UI. The merge deleted the remote branch in that same createdBranch case
	// via --delete-branch.
	function mergeCleanup() {
		const deleteBranch = !!session.worktree?.createdBranch;
		requestDelete(session.id, { deleteWorktree: true, deleteBranch }).catch(() => {});
		goto('/');
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
		deletingIds={del.deletingIds}
		onQuickAdd={quickAdd}
		onShellHere={shellHere}
		onDelete={onDeleteSession}
	/>
{/snippet}

<div class="flex h-full" class:select-none={resizing} class:cursor-col-resize={resizing}>
	<div
		class="relative hidden h-full lg:block lg:shrink-0"
		style="width: {sidebarWidth}px"
	>
		<aside class="h-full overflow-y-auto pt-1">
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
			class="group absolute inset-y-0 -right-1.5 w-3 cursor-col-resize touch-none"
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

	<div class="flex h-full min-w-0 flex-1 flex-col pt-1">
		{#if del.error}
			<div class="alert alert-error mb-2 py-2 text-sm" role="alert">
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
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<button
				class="btn btn-ghost btn-sm shrink-0 lg:hidden"
				onclick={() => (sidebarOpen = true)}
				aria-label="Open sessions"
			>
				<Menu size={16} />
			</button>
			{#if session.kind !== 'claude' && session.kind !== 'shell'}
				<span class="badge badge-ghost badge-sm shrink-0">{session.kind}</span>
			{/if}
			<div class="flex min-w-0 flex-1 items-center gap-2">
				<span class="truncate font-medium">{session.title}</span>
				{#if issueChips.length === 1}
					{@const issue = issueChips[0]}
					{#if issue.url}
						<a
							href={issue.url}
							target="_blank"
							rel="noopener noreferrer"
							class="badge badge-outline badge-sm link link-hover shrink-0 gap-1"
							title="{ISSUE_BADGE[issue.source].label} {issue.id}"
						>
							<Ticket size={12} />
							<span class="hidden sm:inline">{ISSUE_BADGE[issue.source].label} {issue.id}</span>
						</a>
					{:else}
						<span
							class="badge badge-outline badge-sm shrink-0 gap-1"
							title="{ISSUE_BADGE[issue.source].label} {issue.id}"
						>
							<Ticket size={12} />
							<span class="hidden sm:inline">{ISSUE_BADGE[issue.source].label} {issue.id}</span>
						</span>
					{/if}
				{:else if issueChips.length > 1}
					<IssueMenu issues={issueChips} />
				{/if}
				{#if livePr}
					<PrMenu
						id={session.id}
						pr={livePr}
						me={data.me}
						worktree={!!session.worktree}
						createdBranch={!!session.worktree?.createdBranch}
						onMerged={mergeCleanup}
						onChange={refresh}
					/>
				{/if}
				<span class="hidden truncate text-xs opacity-60 sm:inline">{shortPath(session.cwd)}</span>
			</div>
			<div class="flex items-center gap-2">
				{#if serverChip}
					<RunButton {session} serverState={serverChip} onRefresh={refresh} />
					<!-- Status lives in RunButton's collapsed dropdown on mobile (issue #123),
					     so the standalone chip is sm+ only. -->
					<span class="hidden sm:contents"><ServerChip state={serverChip} count={myServers.length} /></span>
				{/if}
				{#if session.kind !== 'shell' && sessionWorkflows.length && !runActive}
					<WorkflowMenu sessionId={session.id} workflows={sessionWorkflows} onChange={refresh} />
				{/if}
				{#if session.kind !== 'shell'}
					<ModelMenu
						id={session.id}
						kind={session.kind}
						model={liveModel}
						disabled={liveStatus === 'running'}
						onChange={refresh}
					/>
				{/if}
				{#if session.kind === 'claude' && session.permissionMode === 'bypassPermissions'}
					<span
						class="badge badge-outline badge-sm hidden shrink-0 sm:inline-flex"
						title="yolo (bypassPermissions)"
					>
						yolo
					</span>
				{/if}
			</div>
		</div>

		{#if liveRun}
			<WorkflowProgress run={liveRun} sessionId={session.id} onChange={refresh} />
		{/if}

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
					<ClaudeView {session} {sessions} />
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

<DeleteSessionModal flow={del} />
