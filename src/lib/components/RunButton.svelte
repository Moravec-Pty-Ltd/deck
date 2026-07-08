<script lang="ts">
	import { untrack } from 'svelte';
	import type { DeckSession, ServerRuntime, ServerState } from '$lib/types';
	import { SERVER_BADGE, SERVER_LABEL } from '$lib/servers';
	import {
		fetchServers,
		serverAction,
		canStart,
		canStop,
		isInFlight,
		type ServerAction
	} from '$lib/servers-client';
	import { dismissOnOutside, keepInView } from '$lib/dismiss';
	import { Play, Square, RotateCw, ListRestart, ChevronDown, Loader2, Server } from '@lucide/svelte';

	// One-click dev-server control in the session header (issue #80, workstream 3).
	// The button's look is driven by the aggregate `state` the page already polls,
	// so this adds no interval; it fetches the server list only for the names/menu
	// (on mount, when the menu opens, and after an action), and nudges the page to
	// re-poll via onRefresh so the state reflects the action without a reload.
	//
	// Layout (issue #123): at sm+ it's the inline split control [Run|Stop][▾] and
	// the ServerChip beside it shows status. On mobile the two collapse into a
	// single dropdown — a compact server-status chip trigger whose menu carries
	// Run/Stop plus the same secondary actions — to save header width.
	let {
		session,
		serverState,
		onRefresh
	}: {
		session: DeckSession;
		serverState: ServerState;
		onRefresh?: () => void;
	} = $props();

	let servers = $state<ServerRuntime[]>([]);
	let busy = $state(false);
	let err = $state<string | null>(null);
	// A load failure while we still have nothing to show, kept apart from `err`
	// (action failures) so an action error isn't wiped by a background refetch.
	let loadErr = $state<string | null>(null);
	let menuOpen = $state(false); // sm+ caret menu
	let mobileMenuOpen = $state(false); // mobile collapsed dropdown
	let loadToken = 0;

	const primary = $derived<ServerRuntime | undefined>(servers[0]);
	const others = $derived(servers.slice(1));
	// Gate on the primary (first) server's own state — the one the button acts on —
	// and fall back to the polled aggregate only until the list loads. Driving the
	// look off the aggregate would invert the control when another server outranks
	// the primary (e.g. showing Stop while the primary is actually stopped).
	const current = $derived<ServerState>(primary?.state ?? serverState);
	// running/stalled read as "stop"; stopped/dead/errored read as "run".
	const runningLike = $derived(canStop(current));
	const mainTint = $derived(
		current === 'errored'
			? 'btn-error'
			: current === 'stalled'
				? 'btn-warning'
				: runningLike
					? ''
					: 'btn-primary'
	);
	// A caret is worth showing for the running split control, errored recovery, or
	// to reach additional servers; a plain stopped single server needs just Run.
	const showCaret = $derived(
		!!primary && (runningLike || current === 'errored' || others.length > 0)
	);

	async function refreshServers() {
		const my = ++loadToken;
		try {
			const list = await fetchServers(session.id);
			// Drop a stale response (a later fetch, or a session switch, already won).
			if (my === loadToken) {
				servers = list;
				loadErr = null;
			}
		} catch (e) {
			// Surface only while we have nothing to show, so a transient mid-session
			// failure (list already loaded) doesn't clobber a working control.
			if (my === loadToken && servers.length === 0) {
				loadErr = e instanceof Error ? e.message : 'failed to load servers';
			}
		}
	}

	// Refetch the list when the session changes (and once on mount) so primary/menu
	// names are ready before a click. Clear the previous session's list first so a
	// click during the switch can't POST the new session id with a stale server
	// name; the button just stays disabled until the refetch lands.
	$effect(() => {
		session.id;
		servers = [];
		err = null;
		loadErr = null;
		menuOpen = false;
		mobileMenuOpen = false;
		void refreshServers();
	});

	// If the list still hasn't loaded (e.g. the first fetch failed), retry off the
	// page's aggregate poll rather than adding our own timer. untrack keeps this
	// reacting to the aggregate only, never re-firing on our writes to `servers`.
	$effect(() => {
		serverState;
		if (untrack(() => servers.length === 0)) void refreshServers();
	});

	async function run(name: string, action: ServerAction) {
		if (busy) return;
		busy = true;
		err = null;
		menuOpen = false;
		mobileMenuOpen = false;
		try {
			await serverAction(session.id, name, action);
		} catch (e) {
			err = e instanceof Error ? e.message : 'action failed';
		} finally {
			busy = false;
			onRefresh?.();
			await refreshServers();
		}
	}

	function primaryClick() {
		if (!primary) return;
		run(primary.name, runningLike ? 'stop' : 'start');
	}

	// If the caret is no longer rendered (config change, the list briefly empties),
	// drop the open flag so no dangling <details> stays flagged open.
	$effect(() => {
		if (!showCaret) menuOpen = false;
	});

	// Refresh the menu's server states whenever either dropdown opens; outside-click
	// dismissal is handled by dismissOnOutside on each <details>.
	$effect(() => {
		if (menuOpen || mobileMenuOpen) void refreshServers();
	});
</script>

<!-- Secondary server actions, shared by the sm+ caret menu and the mobile menu. -->
{#snippet secondaryActions()}
	{#if primary && canStop(primary.state) && !isInFlight(primary.state)}
		<li>
			<button onclick={() => run(primary.name, 'restart')} disabled={busy}>
				<RotateCw size={14} /> Restart
			</button>
		</li>
	{/if}
	{#if primary && !isInFlight(primary.state)}
		<li>
			<button onclick={() => run(primary.name, 'resetup')} disabled={busy}>
				<ListRestart size={14} /> Re-run setup
			</button>
		</li>
	{/if}
	{#if others.length}
		<li class="menu-title px-2 pt-1 text-xs opacity-60">Other servers</li>
		{#each others as o (o.name)}
			<li>
				<button onclick={() => run(o.name, canStart(o.state) ? 'start' : 'stop')} disabled={busy}>
					{#if canStart(o.state)}<Play size={14} />{:else}<Square size={14} />{/if}
					<span class="min-w-0 flex-1 truncate">{o.name}</span>
					<span class="shrink-0 text-xs opacity-60">{SERVER_LABEL[o.state]}</span>
				</button>
			</li>
		{/each}
	{/if}
{/snippet}

<span class="flex shrink-0 items-center gap-1">
	{#if isInFlight(current)}
		<!-- sm+: disabled labelled button; mobile: a plain spinner status chip -->
		<button class="btn btn-xs hidden gap-1 sm:inline-flex" disabled aria-label={SERVER_LABEL[current]}>
			<Loader2 size={14} class="animate-spin" /> {SERVER_LABEL[current]}
		</button>
		<span
			class="badge badge-sm gap-1 sm:hidden {SERVER_BADGE[current]}"
			title="dev servers: {SERVER_LABEL[current]}"
			aria-label={SERVER_LABEL[current]}
		>
			<Loader2 size={11} class="animate-spin" />
		</span>
	{:else}
		<!-- sm+: inline split control [Run|Stop][▾] -->
		<div class="join hidden sm:inline-flex">
			<button
				class="btn join-item btn-xs gap-1 {mainTint}"
				onclick={primaryClick}
				disabled={busy || !primary}
				title={runningLike ? `Stop ${primary?.name ?? ''}` : `Run ${primary?.name ?? ''}`}
			>
				{#if busy}
					<Loader2 size={14} class="animate-spin" />
				{:else if runningLike}
					<Square size={14} />
				{:else}
					<Play size={14} />
				{/if}
				{runningLike ? 'Stop' : 'Run'}
			</button>
			{#if showCaret}
				<details bind:open={menuOpen} class="dropdown dropdown-end" use:dismissOnOutside={() => (menuOpen = false)}>
					<summary
						class="btn join-item btn-xs list-none px-1 [&::-webkit-details-marker]:hidden"
						aria-label="More server actions"
					>
						<ChevronDown size={14} />
					</summary>
					<ul
						class="dropdown-content menu menu-sm z-20 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
						use:keepInView
					>
						{@render secondaryActions()}
					</ul>
				</details>
			{/if}
		</div>

		<!-- mobile: the Run button and ServerChip collapse into one server dropdown -->
		<details
			bind:open={mobileMenuOpen}
			class="dropdown dropdown-end sm:hidden"
			use:dismissOnOutside={() => (mobileMenuOpen = false)}
		>
			<summary
				class="badge badge-sm cursor-pointer list-none gap-1 [&::-webkit-details-marker]:hidden {SERVER_BADGE[current]}"
				title="dev servers: {SERVER_LABEL[current]}"
				aria-label="Server: {SERVER_LABEL[current]}"
			>
				<Server size={11} />
				{#if servers.length > 1}<span class="opacity-70">×{servers.length}</span>{/if}
				<ChevronDown size={11} class="opacity-70" />
			</summary>
			<ul
				class="dropdown-content menu menu-sm z-20 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
				use:keepInView
			>
				<li>
					<button onclick={primaryClick} disabled={busy || !primary}>
						{#if runningLike}<Square size={14} />{:else}<Play size={14} />{/if}
						{runningLike ? 'Stop' : 'Run'}
						{#if primary}<span class="min-w-0 flex-1 truncate opacity-60">{primary.name}</span>{/if}
					</button>
				</li>
				{@render secondaryActions()}
			</ul>
		</details>
	{/if}
	{#if err || loadErr}
		<span class="max-w-[12rem] truncate text-xs text-error" title={err || loadErr}>{err || loadErr}</span>
	{/if}
</span>
