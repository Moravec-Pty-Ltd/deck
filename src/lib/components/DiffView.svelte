<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { DeckSession } from '$lib/types';
	import type { DiffFile, DiffFileStatus } from '$lib/diff';
	import { RefreshCw, Columns2, Rows2 } from '@lucide/svelte';
	import { agentRequest, sessionPath } from '$lib/agent-api';
	import { estimateHeight, startsCollapsed } from '$lib/diff-view-core';

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
	type FileDiffMetadata = import('@pierre/diffs').FileDiffMetadata;
	let diffs: Diffs | null = null;

	// The patch is parsed once per load, but a file's FileDiff (Shiki plus a
	// shadow root) only exists while its block is near the viewport. Drawing a
	// big branch's every file at once froze and crashed the tab.
	type Block = { key: string; path: string; split: number; unified: number; changed: number; collapsed: boolean };
	let blocks = $state.raw<Block[]>([]);
	let parsed: FileDiffMetadata[] = [];
	let slots: HTMLElement[] = [];
	// Only cleanUp() is needed; structural typing avoids the FileDiff generic-variance friction.
	const mounted = new Map<number, { host: HTMLElement; inst: { cleanUp(): void } }>();
	let io: IntersectionObserver | undefined;
	let generation = 0; // fresh block keys per load, so every slot is rebuilt
	const expanded = new Set<string>(); // paths opened with "Show diff", kept across reloads

	let scroller = $state<HTMLDivElement>();
	let ready = $state(false); // the lazy @pierre/diffs import has resolved
	let loading = $state(true);
	let slow = $state(false); // a load has run past SLOW_MS: offer Cancel
	let errMsg = $state<string | null>(null);
	let meta = $state<Meta | null>(null);

	const LAYOUT_KEY = 'deck-diff-layout';
	const SLOW_MS = 2000;
	const NEAR_PX = 1200; // draw within this distance of the viewport, tear down beyond it
	let layout = $state<'split' | 'stacked'>(initialLayout());
	let isDark = $state(true);

	let observer: MutationObserver | undefined;
	let prevStatus = ''; // last seen liveStatus, for the running -> idle edge
	let ctrl: AbortController | null = null; // the in-flight load

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

	function mount(i: number) {
		const slot = slots[i];
		if (!diffs || !slot || mounted.has(i) || blocks[i]?.collapsed) return;
		const host = document.createElement('div');
		host.className = 'diff-file';
		slot.appendChild(host);
		const inst = new diffs.FileDiff({
			theme: { dark: 'github-dark', light: 'github-light' },
			themeType: isDark ? 'dark' : 'light',
			diffStyle: layout === 'split' ? 'split' : 'unified',
			overflow: 'wrap',
			diffIndicators: 'bars',
			expandUnchanged: false,
			collapsedContextThreshold: 5,
			hunkSeparators: 'simple',
			// The first draw can wait on Shiki; hold the placeholder height until then.
			onPostRender: (_node, _inst, phase) => {
				if (phase === 'mount') slot.style.minHeight = '';
			}
		});
		inst.render({ fileDiff: parsed[i], containerWrapper: host });
		mounted.set(i, { host, inst });
	}

	function unmount(i: number) {
		const m = mounted.get(i);
		if (!m) return;
		// Hold the drawn height so the content below doesn't jump.
		const slot = slots[i];
		if (slot) slot.style.minHeight = `${slot.offsetHeight}px`;
		try {
			m.inst.cleanUp();
		} catch {
			// ignore: tearing down a half-rendered instance is best-effort
		}
		m.host.remove();
		mounted.delete(i);
	}

	function unmountAll() {
		for (const i of [...mounted.keys()]) unmount(i);
	}

	// In order, so each target ends in the state of its last record.
	function onIntersect(entries: IntersectionObserverEntry[]) {
		for (const e of entries) {
			const i = Number((e.target as HTMLElement).dataset.i);
			if (slots[i] !== e.target) continue; // queued before a reload replaced the slot
			if (e.isIntersecting) mount(i);
			else unmount(i);
		}
	}

	function placeholder(i: number) {
		const b = blocks[i];
		if (slots[i] && !b.collapsed) slots[i].style.minHeight = `${estimateHeight(layout === 'split' ? b.split : b.unified)}px`;
	}

	// Svelte action on each file's block: size its placeholder and watch it.
	function slot(el: HTMLElement, i: number) {
		slots[i] = el;
		placeholder(i);
		io?.observe(el);
		return {
			destroy() {
				io?.unobserve(el);
				if (slots[i] !== el) return;
				unmount(i);
				delete slots[i];
			}
		};
	}

	function render(patch: string) {
		if (!diffs) return;
		const files = diffs.parsePatchFiles(patch).flatMap((p) => p.files);
		unmountAll();
		parsed = files;
		const gen = ++generation;
		// Keyed by index: git can write two sections for one path (a typechange).
		blocks = parsed.map((f, i) => {
			const changed = f.hunks.reduce((n, h) => n + h.additionLines + h.deletionLines, 0);
			return {
				key: `${gen}:${i}`,
				path: f.name,
				split: f.splitLineCount,
				unified: f.unifiedLineCount,
				changed,
				collapsed: !expanded.has(f.name) && startsCollapsed(f.name, changed)
			};
		});
	}

	function expand(i: number) {
		expanded.add(blocks[i].path);
		blocks = blocks.map((b, j) => (j === i ? { ...b, collapsed: false } : b));
		placeholder(i);
		mount(i);
	}

	// Scroll a summary row's diff block into view and draw it. Instant, not smooth:
	// a smooth scroll would draw every file it passes. No-op for a file dropped by
	// the size cap.
	function jumpTo(path: string) {
		const i = blocks.findIndex((b) => b.path === path);
		const el = slots[i];
		if (!el) return;
		mount(i);
		el.scrollIntoView({ block: 'start' });
		// Files drawn above it on arrival can shift it; settle once they have.
		requestAnimationFrame(() => requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })));
	}

	async function load() {
		ctrl?.abort();
		const c = new AbortController();
		ctrl = c;
		loading = true;
		slow = false;
		errMsg = null;
		const timer = setTimeout(() => {
			if (ctrl === c) slow = true;
		}, SLOW_MS);
		const url = sessionPath(session.id, 'diff');
		let done = false;
		// The summary alone is small and quick: show the size before the patch lands.
		// Only when nothing is drawn yet, so it never disagrees with the files shown.
		if (blocks.length === 0) {
			agentRequest<{ git: boolean; meta?: Meta }>(`${url}?meta=1`, { signal: c.signal })
				.then((d) => {
					if (ctrl === c && !done && d.meta) meta = d.meta;
				})
				.catch(() => {});
		}
		try {
			const data = await agentRequest<{ git: boolean; meta?: Meta; patch?: string }>(url, {
				signal: c.signal
			});
			if (ctrl !== c) return;
			done = true;
			if (!data.git) {
				meta = null;
				render('');
				onCount?.(null);
				return;
			}
			meta = data.meta ?? null;
			onCount?.(meta?.fileCount ?? 0);
			render(data.patch ?? '');
		} catch (e) {
			if (ctrl !== c) return;
			errMsg = c.signal.aborted ? 'Load cancelled.' : (e as Error)?.message || "Couldn't load diff";
		} finally {
			clearTimeout(timer);
			// A superseded load leaves the flags to the live one.
			if (ctrl === c) {
				ctrl = null;
				loading = false;
				slow = false;
			}
		}
	}

	// A layout/theme change redraws only the files on screen.
	function rerender() {
		if (!ready) return;
		for (const i of [...mounted.keys()]) {
			unmount(i);
			mount(i);
		}
	}

	function setLayout(next: 'split' | 'stacked') {
		if (layout === next) return;
		layout = next;
		if (typeof localStorage !== 'undefined') localStorage.setItem(LAYOUT_KEY, next);
		// Undrawn files were sized for the old layout.
		for (let i = 0; i < blocks.length; i++) if (!mounted.has(i)) placeholder(i);
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
		io = new IntersectionObserver(onIntersect, { root: scroller, rootMargin: `${NEAR_PX}px 0px` });
		let cancelled = false;
		import('@pierre/diffs')
			.then((m) => {
				if (cancelled) return;
				diffs = m;
				ready = true;
				void load();
			})
			.catch(() => {
				errMsg = "Couldn't load the diff renderer";
				loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => {
		ctrl?.abort();
		ctrl = null;
		observer?.disconnect();
		io?.disconnect();
		unmountAll();
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
		{#if slow}
			<button class="btn btn-ghost btn-sm shrink-0" onclick={() => ctrl?.abort()}>Cancel</button>
		{/if}
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
			Diff too large. All {meta.fileCount} files are listed below; showing the first {blocks.length}
			{blocks.length === 1 ? 'diff' : 'diffs'}, the rest were omitted.
		</div>
	{/if}
	{#if errMsg}
		<div class="alert alert-error mb-2 py-2 text-sm break-words">{errMsg}</div>
	{/if}

	<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto">
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
		{#if loading && meta && blocks.length === 0}
			<div class="flex items-center gap-2 py-2 text-xs opacity-60">
				<span class="loading loading-spinner loading-xs"></span> Loading diffs…
			</div>
		{/if}
		<div class="space-y-3" class:hidden={empty}>
			{#each blocks as block, i (block.key)}
				<div use:slot={i} data-i={i} class="rounded bg-base-200/40">
					{#if block.collapsed}
						<div class="flex items-center gap-2 px-3 py-2 text-xs">
							<span class="min-w-0 flex-1 truncate font-mono">{block.path}</span>
							<span class="shrink-0 opacity-60">{block.changed.toLocaleString()} changed lines</span>
							<button type="button" class="btn btn-xs shrink-0" onclick={() => expand(i)}>Show diff</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>
