<script lang="ts">
	import { FileText } from '@lucide/svelte';
	import { findFilePaths, formatBytes, isVideoMime, type FileInfo } from '$lib/files-core';
	import { fileUrl, statFiles } from '$lib/file-stat';
	import Lightbox from './Lightbox.svelte';

	// The local files a message mentions, under its text: images as previews
	// that open full size (with the message's other images alongside), videos
	// as players, other files as chips that open or download. Only files deck can serve show up;
	// a mention of something missing or outside the projects stays plain text.
	let { text, sessionId }: { text: string; sessionId: string } = $props();

	const paths = $derived(findFilePaths(text));
	let files: FileInfo[] = $state([]);

	$effect(() => {
		const wanted = paths;
		if (!wanted.length) {
			files = [];
			return;
		}
		let live = true;
		statFiles(sessionId, wanted).then((found) => {
			if (live) files = found;
		});
		return () => {
			live = false;
		};
	});

	const images = $derived(files.filter((f) => f.image));
	const videos = $derived(files.filter((f) => isVideoMime(f.mime)));
	const others = $derived(files.filter((f) => !f.image && !isVideoMime(f.mime)));
	let galleryOpen = $state(false);
	let galleryIndex = $state(0);
	const gallery = $derived(
		images.map((f) => ({ src: fileUrl(sessionId, f.path), name: f.name, download: fileUrl(sessionId, f.path, true) }))
	);
</script>

{#if files.length}
	<div class="mt-2 flex flex-wrap items-end gap-2">
		{#each images as f, i (f.path)}
			<button
				type="button"
				class="rounded-box border border-base-300 bg-base-200 p-0.5 transition-opacity hover:opacity-90"
				onclick={() => {
					galleryIndex = i;
					galleryOpen = true;
				}}
				aria-label="Open {f.name}"
				title={f.name}
			>
				<img
					src={fileUrl(sessionId, f.path)}
					alt={f.name}
					loading="lazy"
					class="max-h-40 max-w-full rounded-box object-contain"
				/>
			</button>
		{/each}
		{#each videos as f (f.path)}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				src={fileUrl(sessionId, f.path)}
				controls
				playsinline
				preload="metadata"
				title={f.name}
				class="max-h-64 max-w-full rounded-box border border-base-300 bg-base-200"
			></video>
		{/each}
		{#each others as f (f.path)}
			<a
				href={fileUrl(sessionId, f.path)}
				target="_blank"
				rel="noopener noreferrer"
				class="badge badge-ghost h-auto gap-1.5 px-2 py-1 text-xs no-underline"
				title={f.path}
			>
				<FileText size={14} />
				<span class="max-w-48 truncate">{f.name}</span>
				<span class="opacity-60">{formatBytes(f.size)}</span>
			</a>
		{/each}
	</div>
{/if}

{#if galleryOpen && gallery.length}
	<Lightbox images={gallery} bind:index={galleryIndex} onclose={() => (galleryOpen = false)} />
{/if}
