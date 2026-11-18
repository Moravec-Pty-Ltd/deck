<script lang="ts">
	import { Download, WrapText, X } from '@lucide/svelte';
	import Markdown from './Markdown.svelte';
	import { ensureHighlighter, renderCode } from '$lib/markdown/highlighter.svelte';
	import { MAX_TEXT_PREVIEW_BYTES, langFor, looksBinary, viewerFor } from '$lib/file-browser-core';
	import { formatBytes, type FileInfo } from '$lib/files-core';
	import { fileUrl } from '$lib/file-stat';

	// A text file a message names, read in place over the session: Markdown
	// renders (with a source toggle), anything else shows highlighted. Opened by
	// FileAttachments for text-like files, so a report or a README reads like
	// the Files tab instead of as a raw browser tab.
	let { sessionId, file, onclose }: { sessionId: string; file: FileInfo; onclose: () => void } = $props();

	// Highlighting a very large file in one go stalls the page; past this it
	// shows as plain text.
	const MAX_HIGHLIGHT_BYTES = 200 * 1024;

	let text = $state<string | null>(null);
	let error = $state('');
	let showSource = $state(false);
	let wrap = $state(true);

	const markdown = $derived(viewerFor(file.name) === 'markdown');
	const asCode = $derived(!markdown || showSource);

	$effect(() => {
		void load(file);
	});

	$effect(() => {
		if (asCode) ensureHighlighter();
	});

	async function load(f: FileInfo) {
		text = null;
		error = '';
		if (f.size > MAX_TEXT_PREVIEW_BYTES) {
			error = `Too large to read here (${formatBytes(f.size)}). Download it instead.`;
			return;
		}
		try {
			const res = await fetch(fileUrl(sessionId, f.path));
			if (!res.ok) {
				error = 'This file cannot be opened from here.';
				return;
			}
			const body = await res.text();
			if (looksBinary(body)) error = 'This is not a text file.';
			else text = body;
		} catch {
			error = 'could not reach deck';
		}
	}

	// Safe {@html}: renderCode returns Shiki markup or escaped text (highlight-core.ts).
	const codeHtml = $derived(
		text === null || !asCode
			? ''
			: renderCode(text, text.length > MAX_HIGHLIGHT_BYTES ? '' : markdown ? 'markdown' : langFor(file.name))
	);

	function onKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		onclose();
	}

	let closeButton: HTMLButtonElement | undefined = $state();
	$effect(() => closeButton?.focus());
</script>

<svelte:window onkeydown={onKey} />

<div
	class="fixed inset-0 z-50 flex flex-col bg-base-100"
	style="padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
	role="dialog"
	aria-modal="true"
	aria-label={file.name}
>
	<div class="flex items-center gap-2 border-b border-base-300 px-3 py-2">
		<div class="min-w-0 flex-1">
			<div class="truncate text-sm font-semibold">{file.name}</div>
			<div class="truncate text-xs text-base-content/60" title={file.path}>{formatBytes(file.size)} · {file.path}</div>
		</div>
		{#if markdown && text !== null}
			<button class="btn btn-ghost btn-xs" onclick={() => (showSource = !showSource)}>
				{showSource ? 'Rendered' : 'Source'}
			</button>
		{/if}
		{#if asCode && text !== null}
			<button
				class="btn btn-ghost btn-xs gap-1 {wrap ? 'btn-active' : ''}"
				onclick={() => (wrap = !wrap)}
				aria-pressed={wrap}
			>
				<WrapText size={14} /> wrap
			</button>
		{/if}
		<a
			href={fileUrl(sessionId, file.path, true)}
			download={file.name}
			class="btn btn-square btn-ghost btn-sm"
			aria-label="Download"
			title="Download"
		>
			<Download size={16} />
		</a>
		<button
			type="button"
			bind:this={closeButton}
			class="btn btn-square btn-ghost btn-sm"
			onclick={onclose}
			aria-label="Close"
			title="Close"
		>
			<X size={16} />
		</button>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
		{#if error}
			<p class="text-sm text-warning">{error}</p>
		{:else if text === null}
			<p class="text-sm text-base-content/60">Loading…</p>
		{:else if !asCode}
			<div class="mx-auto max-w-3xl"><Markdown source={text} /></div>
		{:else}
			<div class="markdown file-code" class:file-code-wrap={wrap}>{@html codeHtml}</div>
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
