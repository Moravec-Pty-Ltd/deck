<script lang="ts">
	import { untrack } from 'svelte';
	import type { DeckSession, ServerRuntime, ServerState } from '$lib/types';
	import { SERVER_LABEL } from '$lib/servers';
	import {
		fetchServers,
		serverAction,
		canStart,
		canStop,
		isInFlight,
		type ServerAction
	} from '$lib/servers-client';
	import { Play, Square, RotateCw, ListRestart, ChevronDown, Loader2 } from '@lucide/svelte';

	// One-click dev-server control in the session header (issue #80, workstream 3).
	// The button's look is driven by the aggregate `state` the page already polls,
	// so this adds no interval; it fetches the server list only for the names/menu
	// (on mount, when the menu opens, and after an action), and nudges the page to
	// re-poll via onRefresh so the state reflects the action without a reload.
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
	let menuOpen = $state(false);
	let menuEl = $state<HTMLDetailsElement>();
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
	// drop the open flag so no dangling outside-click listener or stuck-open state
	// survives the <details> unmounting.
	$effect(() => {
		if (!showCaret) menuOpen = false;
	});

	// Close the menu on an outside click, and refresh its server states on open.
	$effect(() => {
		if (!menuOpen) return;
		void refreshServers();
		function onDown(e: PointerEvent) {
			if (menuEl && !menuEl.contains(e.target as Node)) menuOpen = false;
		}
		window.addEventListener('pointerdown', onDown, true);
		return () => window.removeEventListener('pointerdown', onDown, true);
	});
</script>

<span class="flex shrink-0 items-center gap-1">
	{#if isInFlight(current)}
		<button class="btn btn-sm gap-1" disabled aria-label={SERVER_LABEL[current]}>
			<Loader2 size={14} class="animate-spin" /> {SERVER_LABEL[current]}
		</button>
	{:else}
		<div class="join">
			<button
				class="btn join-item btn-sm gap-1 {mainTint}"
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
				<details bind:open={menuOpen} bind:this={menuEl} class="dropdown dropdown-end">
					<summary
						class="btn join-item btn-sm list-none px-1 [&::-webkit-details-marker]:hidden"
						aria-label="More server actions"
					>
						<ChevronDown size={14} />
					</summary>
					<ul
						class="dropdown-content menu menu-sm z-20 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
					>
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
									<button
										onclick={() => run(o.name, canStart(o.state) ? 'start' : 'stop')}
										disabled={busy}
									>
										{#if canStart(o.state)}<Play size={14} />{:else}<Square size={14} />{/if}
										<span class="min-w-0 flex-1 truncate">{o.name}</span>
										<span class="shrink-0 text-xs opacity-60">{SERVER_LABEL[o.state]}</span>
									</button>
								</li>
							{/each}
						{/if}
					</ul>
				</details>
			{/if}
		</div>
	{/if}
	{#if err || loadErr}
		<span class="max-w-[12rem] truncate text-xs text-error" title={err || loadErr}>{err || loadErr}</span>
	{/if}
</span>
