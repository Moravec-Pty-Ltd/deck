<script lang="ts">
	// The session's Files tab: browse the session's folder and open a file in
	// place. Markdown renders (with a source toggle), text and code are
	// highlighted, images, PDFs, video and audio show inline, and anything else
	// is a download. Listings come from ../dir and files from ../files, both held
	// to the registered projects on the server.
	import { untrack } from 'svelte';
	import {
		ArrowLeft,
		Download,
		Eye,
		EyeOff,
		File,
		FileText,
		Folder,
		Image as ImageIcon,
		KeyRound,
		RefreshCw,
		WrapText,
		ExternalLink
	} from '@lucide/svelte';
	import type { DeckSession } from '$lib/types';
	import { fileUrl } from '$lib/file-stat';
	import { formatBytes } from '$lib/files-core';
	import {
		MAX_TEXT_PREVIEW_BYTES,
		crumbs,
		isSecretName,
		isTucked,
		joinRel,
		langFor,
		looksBinary,
		parentRel,
		viewerFor,
		type DirEntry,
		type DirListing
	} from '$lib/file-browser-core';
	import Markdown from './Markdown.svelte';
	import { ensureHighlighter, renderCode } from '$lib/markdown/highlighter.svelte';

	let { session, visible = true }: { session: DeckSession; visible?: boolean } = $props();

	// Highlighting a very large file in one go stalls the page; past this it
	// shows as plain text.
	const MAX_HIGHLIGHT_BYTES = 200 * 1024;

	let dirPath = $state('');
	let listing = $state<DirListing | null>(null);
	let listError = $state('');
	let loading = $state(false);
	let showHidden = $state(false);

	let open = $state<DirEntry | null>(null);
	let text = $state<string | null>(null);
	let textError = $state('');
	let revealed = $state(false);
	let showSource = $state(false);
	let wrap = $state(true);

	const base = $derived(`/api/sessions/${encodeURIComponent(session.id)}`);
	const shown = $derived((listing?.entries ?? []).filter((e) => showHidden || !isTucked(e)));
	const tuckedCount = $derived((listing?.entries.length ?? 0) - shown.length);
	const trail = $derived(listing ? crumbs(listing.root, open ? joinRel(dirPath, open.name) : dirPath) : []);
	const openPath = $derived(open && listing ? `${listing.root}/${joinRel(dirPath, open.name)}` : '');
	const viewer = $derived(open ? viewerFor(open.name) : null);
	const secret = $derived(open ? isSecretName(open.name) : false);
	const lang = $derived(open ? langFor(open.name) : '');

	async function load(rel: string) {
		loading = true;
		listError = '';
		try {
			const res = await fetch(`${base}/dir?path=${encodeURIComponent(rel)}`);
			if (!res.ok) {
				listError = (await res.json().catch(() => null))?.message ?? `could not list this folder (${res.status})`;
				return;
			}
			listing = await res.json();
			dirPath = rel;
		} catch {
			listError = 'could not reach deck';
		} finally {
			loading = false;
		}
	}

	async function loadText(entry: DirEntry, absolute: string) {
		text = null;
		textError = '';
		if (entry.size > MAX_TEXT_PREVIEW_BYTES) {
			textError = `Too large to preview (${formatBytes(entry.size)}).`;
			return;
		}
		try {
			const res = await fetch(fileUrl(session.id, absolute));
			if (!res.ok) {
				textError = 'This file cannot be opened from here.';
				return;
			}
			const body = await res.text();
			if (looksBinary(body)) textError = 'This is not a text file.';
			else text = body;
		} catch {
			textError = 'could not reach deck';
		}
	}

	function enter(entry: DirEntry) {
		listError = '';
		if (entry.dir) {
			open = null;
			void load(joinRel(dirPath, entry.name));
			return;
		}
		open = entry;
		revealed = false;
		showSource = false;
		text = null;
		textError = '';
	}

	function goTo(rel: string) {
		open = null;
		if (rel !== dirPath || !listing) void load(rel);
	}

	function back() {
		if (open) open = null;
		else if (dirPath) void load(parentRel(dirPath));
	}

	// Text-like files are fetched once they are actually visible (a secret only
	// after it is revealed).
	$effect(() => {
		const entry = open;
		const path = openPath;
		const v = viewer;
		if (!entry || !path || (v !== 'text' && v !== 'markdown')) return;
		if (secret && !revealed) return;
		untrack(() => void loadText(entry, path));
	});

	$effect(() => {
		if (visible && !listing && !loading && !listError) untrack(() => void load(''));
	});

	$effect(() => {
		if (viewer === 'text' || (viewer === 'markdown' && showSource)) ensureHighlighter();
	});

	// Safe {@html}: renderCode returns Shiki markup or escaped text (highlight-core.ts).
	const codeHtml = $derived(
		text === null ? '' : renderCode(text, text.length > MAX_HIGHLIGHT_BYTES ? '' : viewer === 'markdown' ? 'markdown' : lang)
	);

	function when(ms: number): string {
		const d = new Date(ms);
		const sameYear = d.getFullYear() === new Date().getFullYear();
		return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="mb-2 flex shrink-0 items-center gap-1">
		<button
			class="btn btn-ghost btn-sm btn-square"
			onclick={back}
			disabled={!open && !dirPath}
			aria-label="Up one level"
		>
			<ArrowLeft size={16} />
		</button>
		<nav class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-sm" aria-label="Path">
			{#each trail as crumb, i (crumb.path + i)}
				{#if i > 0}<span class="mx-0.5 opacity-40">/</span>{/if}
				{#if i === trail.length - 1}
					<span class="font-medium">{crumb.label}</span>
				{:else}
					<button class="link link-hover" onclick={() => goTo(crumb.path)}>{crumb.label}</button>
				{/if}
			{/each}
		</nav>
		{#if open}
			<a class="btn btn-ghost btn-sm btn-square" href={fileUrl(session.id, openPath, true)} aria-label="Download">
				<Download size={16} />
			</a>
		{:else}
			<button
				class="btn btn-ghost btn-sm btn-square {showHidden ? 'btn-active' : ''}"
				onclick={() => (showHidden = !showHidden)}
				aria-pressed={showHidden}
				aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
				title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
			>
				{#if showHidden}<Eye size={16} />{:else}<EyeOff size={16} />{/if}
			</button>
			<button class="btn btn-ghost btn-sm btn-square" onclick={() => load(dirPath)} aria-label="Refresh">
				<RefreshCw size={16} class={loading ? 'animate-spin' : ''} />
			</button>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto rounded-box border border-base-300 bg-base-100">
		{#if listError}
			<p class="border-b border-base-300 p-3 text-sm text-warning">{listError}</p>
		{/if}
		{#if open}
			<div class="p-3">
				<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-base-content/60">
					<span>{formatBytes(open.size)}</span>
					<span>·</span>
					<span>{when(open.mtimeMs)}</span>
					<div class="flex-1"></div>
					{#if viewer === 'markdown' && text !== null}
						<button class="btn btn-ghost btn-xs" onclick={() => (showSource = !showSource)}>
							{showSource ? 'Rendered' : 'Source'}
						</button>
					{/if}
					{#if (viewer === 'text' || showSource) && text !== null}
						<button
							class="btn btn-ghost btn-xs gap-1 {wrap ? 'btn-active' : ''}"
							onclick={() => (wrap = !wrap)}
							aria-pressed={wrap}
						>
							<WrapText size={14} /> wrap
						</button>
					{/if}
					{#if viewer === 'pdf'}
						<a class="btn btn-ghost btn-xs gap-1" href={fileUrl(session.id, openPath)} target="_blank" rel="noopener">
							<ExternalLink size={14} /> open
						</a>
					{/if}
				</div>

				{#if secret && !revealed && (viewer === 'text' || viewer === 'markdown')}
					<div class="flex flex-col items-center gap-3 py-10 text-center text-sm text-base-content/70">
						<KeyRound size={28} class="opacity-50" />
						<p>This file may contain passwords or keys.</p>
						<button class="btn btn-sm" onclick={() => (revealed = true)}>Show contents</button>
					</div>
				{:else if viewer === 'image'}
					<img src={fileUrl(session.id, openPath)} alt={open.name} class="mx-auto max-h-[75vh] max-w-full rounded" />
				{:else if viewer === 'pdf'}
					<iframe src={fileUrl(session.id, openPath)} title={open.name} class="h-[75vh] w-full rounded border-0"></iframe>
				{:else if viewer === 'video'}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video src={fileUrl(session.id, openPath)} controls class="mx-auto max-h-[75vh] max-w-full rounded"></video>
				{:else if viewer === 'audio'}
					<audio src={fileUrl(session.id, openPath)} controls class="w-full"></audio>
				{:else if viewer === 'binary' || textError}
					<div class="flex flex-col items-center gap-3 py-10 text-center text-sm text-base-content/70">
						<File size={28} class="opacity-50" />
						<p>{textError || 'No preview for this kind of file.'}</p>
						<a class="btn btn-sm gap-1" href={fileUrl(session.id, openPath, true)}><Download size={14} /> Download</a>
					</div>
				{:else if text === null}
					<p class="text-sm text-base-content/60">Loading…</p>
				{:else if viewer === 'markdown' && !showSource}
					<Markdown source={text} />
				{:else}
					<div class="markdown file-code" class:file-code-wrap={wrap}>{@html codeHtml}</div>
				{/if}
			</div>
		{:else if listing}
			{#if shown.length === 0}
				<p class="p-4 text-sm text-base-content/60">
					{listing.entries.length ? 'Only hidden files here.' : 'This folder is empty.'}
				</p>
			{/if}
			<ul class="divide-y divide-base-300">
				{#each shown as entry (entry.name)}
					<li>
						<button
							class="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-base-200 active:bg-base-200"
							onclick={() => enter(entry)}
						>
							{#if entry.dir}
								<Folder size={18} class="shrink-0 text-primary" />
							{:else if isSecretName(entry.name)}
								<KeyRound size={18} class="shrink-0 opacity-60" />
							{:else if viewerFor(entry.name) === 'image'}
								<ImageIcon size={18} class="shrink-0 opacity-60" />
							{:else if viewerFor(entry.name) === 'binary'}
								<File size={18} class="shrink-0 opacity-60" />
							{:else}
								<FileText size={18} class="shrink-0 opacity-60" />
							{/if}
							<span class="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
							<span class="shrink-0 text-xs text-base-content/50 tabular-nums">
								{entry.dir ? '' : formatBytes(entry.size)}
							</span>
						</button>
					</li>
				{/each}
			</ul>
			{#if tuckedCount > 0 && !showHidden}
				<button class="w-full p-3 text-xs text-base-content/50 hover:underline" onclick={() => (showHidden = true)}>
					{tuckedCount} hidden {tuckedCount === 1 ? 'item' : 'items'}
				</button>
			{/if}
			{#if listing.truncated}
				<p class="p-3 text-xs text-base-content/50">Showing the first {listing.entries.length} entries.</p>
			{/if}
		{:else if !listError}
			<p class="p-4 text-sm text-base-content/60">Loading…</p>
		{/if}
	</div>
</div>

<style>
	.file-code :global(pre) {
		margin: 0;
	}
	.file-code-wrap :global(pre code),
	.file-code-wrap :global(pre) {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
