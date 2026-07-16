<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { DeckSession } from '$lib/types';
	import type { DiffFile, DiffFileStatus } from '$lib/diff';
	import { RefreshCw, Columns2, Rows2 } from '@lucide/svelte';

	let {
		session,
		liveStatus,
		onCount
	}: {
		session: DeckSession;
		liveStatus: string;
		onCount?: (n: number | null) => void;
	} = $props();

	type Meta = {
		fileCount: number;
		additions: number;
		deletions: number;
		baseRef: string;
		baseResolved: boolean;
		truncated: boolean;
		files: DiffFile[];
	};

	// Per-file status glyph, colour and sort order for the summary list.
	const STATUS: Record<DiffFileStatus, { letter: string; label: string; cls: string; order: number }> = {
		added: { letter: 'A', label: 'Added', cls: 'text-success', order: 0 },
		modified: { letter: 'M', label: 'Modified', cls: 'text-warning', order: 1 },
		renamed: { letter: 'R', label: 'Renamed', cls: 'text-info', order: 2 },
		deleted: { letter: 'D', label: 'Deleted', cls: 'text-error', order: 3 }
	};

	// @pierre/diffs is a Shadow-DOM web component built on Shiki, so it only runs
	// in the browser. It's loaded lazily (dynamic import in onMount) to keep it
	// out of the SSR bundle and off the initial page load until Changes is opened.
	type Diffs = typeof import('@pierre/diffs');
	let diffs: Diffs | null = null;
	// Only cleanUp() is needed across renders; structural typing avoids the
	// FileDiff<undefined> vs FileDiff<unknown> generic-variance friction.
	let instances: { cleanUp(): void }[] = [];
	// The rendered @pierre/diffs mount per file path, so a summary row can scroll to
	// its diff block. Rebuilt on every render(); a path with no mount (a
	// truncated-out file) just no-ops on click.
	let fileMounts = new Map<string, HTMLElement>();

	let container = $state<HTMLDivElement>();
	let ready = $state(false); // the lazy @pierre/diffs import has resolved
	let loading = $state(true);
	let errMsg = $state<string | null>(null);
	let meta = $state<Meta | null>(null);
	let patch = $state('');
	let shownFiles = $state(0);

	const LAYOUT_KEY = 'deck-diff-layout';
	let layout = $state<'split' | 'stacked'>(initialLayout());
	let isDark = $state(true);

	let observer: MutationObserver | undefined;
	let prevStatus = ''; // last seen liveStatus, for the running -> idle edge
	let token = 0; // bumps on each load so stale responses are dropped

	function initialLayout(): 'split' | 'stacked' {
		if (typeof localStorage !== 'undefined') {
			const v = localStorage.getItem(LAYOUT_KEY);
			if (v === 'split' || v === 'stacked') return v;
		}
		// Default: side-by-side on wide viewports, unified on narrow/mobile.
		const wide =
			typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
		return wide ? 'split' : 'stacked';
	}

	function themeIsDark(): boolean {
		// deck themes: 'dark' is the only dark one; 'light'/'eink' read as light.
		return (document.documentElement.dataset.theme || 'dark') === 'dark';
	}

	function teardown() {
		for (const inst of instances) {
			try {
				inst.cleanUp();
			} catch {
				// ignore: tearing down a half-rendered instance is best-effort
			}
		}
		instances = [];
		fileMounts.clear();
		if (container) container.innerHTML = '';
	}

	function render() {
		if (!diffs || !container) return;
		teardown();
		const files = diffs.parsePatchFiles(patch).flatMap((p) => p.files);
		shownFiles = files.length;
		for (const fileDiff of files) {
			const mount = document.createElement('div');
			mount.className = 'diff-file';
			container.appendChild(mount);
			fileMounts.set(fileDiff.name, mount);
			const inst = new diffs.FileDiff({
				theme: { dark: 'github-dark', light: 'github-light' },
				themeType: isDark ? 'dark' : 'light',
				diffStyle: layout === 'split' ? 'split' : 'unified',
				overflow: 'wrap',
				diffIndicators: 'bars',
				expandUnchanged: false,
				collapsedContextThreshold: 5,
				hunkSeparators: 'simple'
			});
			inst.render({ fileDiff, containerWrapper: mount });
			instances.push(inst);
		}
	}

	// Scroll a summary row's diff block into view. No-op if that file's diff isn't
	// mounted (e.g. it was dropped by the size cap).
	function jumpTo(path: string) {
		fileMounts.get(path)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}

	async function load() {
		const my = ++token;
		loading = true;
		errMsg = null;
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/diff`);
			if (my !== token) return;
			if (!res.ok) throw new Error(`diff request failed (${res.status})`);
			const data = await res.json();
			if (my !== token) return;
			if (!data.git) {
				meta = null;
				patch = '';
				shownFiles = 0;
				teardown();
				onCount?.(null);
				return;
			}
			meta = data.meta;
			patch = data.patch ?? '';
			onCount?.(meta?.fileCount ?? 0);
			render();
		} catch (e) {
			if (my !== token) return;
			errMsg = e instanceof Error ? e.message : 'failed to load diff';
		} finally {
			// On a stale response (unmount or a newer load) leave loading as-is so
			// we don't clobber the live load; the winning load owns the flag.
			if (my === token) loading = false;
		}
	}

	// A layout/theme change just re-renders the current patch. Skip it while a
	// load is in flight (or before the import lands): that load's own render()
	// already picks up the latest layout/theme, so rendering here would only
	// flash the previous patch.
	function rerender() {
		if (ready && !loading) render();
	}

	function setLayout(next: 'split' | 'stacked') {
		if (layout === next) return;
		layout = next;
		if (typeof localStorage !== 'undefined') localStorage.setItem(LAYOUT_KEY, next);
		rerender();
	}

	function onThemeChanged() {
		const dark = themeIsDark();
		if (dark === isDark) return;
		isDark = dark;
		rerender();
	}

	// Auto-refresh on turn end: when the session goes running -> idle/error, the
	// agent has just finished a turn, so the worktree may have changed.
	$effect(() => {
		const s = liveStatus;
		if (prevStatus === 'running' && s !== 'running') void load();
		prevStatus = s;
	});

	onMount(() => {
		isDark = themeIsDark();
		observer = new MutationObserver(onThemeChanged);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme']
		});
		let cancelled = false;
		import('@pierre/diffs')
			.then((m) => {
				if (cancelled) return;
				diffs = m;
				ready = true;
				void load();
			})
			.catch(() => {
				errMsg = 'failed to load the diff renderer';
				loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => {
		token++; // invalidate any in-flight load
		observer?.disconnect();
		teardown();
	});

	const empty = $derived(!!meta && meta.fileCount === 0);
	// Grouped by status (added, modified, renamed, deleted) then path, so the kinds
	// of change read at a glance regardless of git's alphabetical patch order.
	const sortedFiles = $derived(
		[...(meta?.files ?? [])].sort(
			(a, b) => STATUS[a.status].order - STATUS[b.status].order || a.path.localeCompare(b.path)
		)
	);
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="mb-2 flex items-center gap-2">
		<div class="flex min-w-0 flex-1 items-center gap-2 text-sm">
			{#if meta && meta.fileCount > 0}
				<span class="font-medium">{meta.fileCount} {meta.fileCount === 1 ? 'file' : 'files'}</span>
				{#if meta.additions}<span class="font-mono text-success">+{meta.additions}</span>{/if}
				{#if meta.deletions}<span class="font-mono text-error">-{meta.deletions}</span>{/if}
			{/if}
			<span class="truncate text-xs opacity-60">vs {meta?.baseRef ?? 'base'}</span>
		</div>
		<div class="join shrink-0">
			<button
				class="btn join-item btn-sm {layout === 'split' ? 'btn-active' : 'btn-ghost'}"
				onclick={() => setLayout('split')}
				aria-pressed={layout === 'split'}
				aria-label="Side-by-side"
				title="Side-by-side"
			>
				<Columns2 size={14} />
			</button>
			<button
				class="btn join-item btn-sm {layout === 'stacked' ? 'btn-active' : 'btn-ghost'}"
				onclick={() => setLayout('stacked')}
				aria-pressed={layout === 'stacked'}
				aria-label="Unified"
				title="Unified"
			>
				<Rows2 size={14} />
			</button>
		</div>
		<button
			class="btn btn-ghost btn-sm shrink-0"
			onclick={() => load()}
			disabled={loading || !ready}
			aria-label="Refresh diff"
			title="Refresh"
		>
			<RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
		</button>
	</div>

	{#if meta && !meta.baseResolved}
		<div class="alert alert-warning mb-2 py-2 text-xs">
			Base branch couldn't be resolved. Showing uncommitted changes against HEAD.
		</div>
	{/if}
	{#if meta?.truncated}
		<div class="alert alert-warning mb-2 py-2 text-xs">
			Diff too large. All {meta.fileCount} files are listed below; showing the first {shownFiles}
			{shownFiles === 1 ? 'diff' : 'diffs'}, the rest were omitted.
		</div>
	{/if}
	{#if errMsg}
		<div class="alert alert-error mb-2 py-2 text-sm break-words">{errMsg}</div>
	{/if}

	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if loading && !meta}
			<div class="flex h-full items-center justify-center">
				<span class="loading loading-spinner loading-md opacity-50"></span>
			</div>
		{:else if empty}
			<div class="flex h-full items-center justify-center text-sm opacity-60">No changes vs base.</div>
		{/if}
		{#if !empty && sortedFiles.length > 0}
			<ul class="mb-3 flex flex-col gap-px text-xs">
				{#each sortedFiles as file (file.path)}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-base-200"
							onclick={() => jumpTo(file.path)}
							title="Jump to {file.path}"
						>
							<span
								class="w-4 shrink-0 text-center font-mono font-semibold {STATUS[file.status].cls}"
								title={STATUS[file.status].label}
								aria-label={STATUS[file.status].label}>{STATUS[file.status].letter}</span
							>
							<span class="min-w-0 flex-1 truncate font-mono">
								{#if file.status === 'renamed' && file.oldPath}
									<span class="opacity-60">{file.oldPath} → </span>{file.path}
								{:else}
									{file.path}
								{/if}
							</span>
							{#if file.binary}
								<span class="shrink-0 opacity-50">binary</span>
							{:else}
								{#if file.additions}<span class="shrink-0 font-mono text-success"
										>+{file.additions}</span
									>{/if}
								{#if file.deletions}<span class="shrink-0 font-mono text-error"
										>-{file.deletions}</span
									>{/if}
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<div bind:this={container} class="space-y-3" class:hidden={empty}></div>
	</div>
</div>
