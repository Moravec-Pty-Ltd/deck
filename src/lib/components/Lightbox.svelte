<script lang="ts">
	import { ChevronLeft, ChevronRight, Download, X } from '@lucide/svelte';

	// A message's images at full size, one at a time: arrows, the arrow keys, or
	// a swipe move between them, Escape or the backdrop closes. Opened by
	// FileAttachments at the image that was clicked.
	export interface LightboxImage {
		src: string;
		name: string;
		download: string;
	}

	let {
		images,
		index = $bindable(0),
		onclose
	}: { images: LightboxImage[]; index?: number; onclose: () => void } = $props();

	const count = $derived(images.length);
	const current = $derived(images[index]);

	function prev() {
		index = (index - 1 + count) % count;
	}
	function next() {
		index = (index + 1) % count;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
		else if (e.key === 'ArrowLeft' && count > 1) prev();
		else if (e.key === 'ArrowRight' && count > 1) next();
		else return;
		e.preventDefault();
	}

	// A horizontal drag of 40px or more moves on; a tap on the backdrop closes.
	let startX: number | null = null;
	let swiped = false;
	function onPointerDown(e: PointerEvent) {
		startX = e.clientX;
		swiped = false;
	}
	function onPointerUp(e: PointerEvent) {
		if (startX === null) return;
		const dx = e.clientX - startX;
		startX = null;
		if (Math.abs(dx) < 40 || count < 2) return;
		swiped = true;
		if (dx < 0) next();
		else prev();
	}
	function onBackdropClick() {
		if (!swiped) onclose();
	}

	let closeButton: HTMLButtonElement | undefined = $state();
	$effect(() => closeButton?.focus());
</script>

<svelte:window onkeydown={onKey} />

<div
	class="fixed inset-0 z-50 flex flex-col bg-black/90 text-white select-none"
	role="dialog"
	aria-modal="true"
	aria-label={current.name}
>
	<div class="flex items-center justify-between gap-2 px-3 py-2 text-sm">
		<span class="truncate opacity-80">
			{current.name}{#if count > 1}<span class="opacity-60"> · {index + 1} / {count}</span>{/if}
		</span>
		<div class="flex shrink-0 gap-1">
			<a
				href={current.download}
				download={current.name}
				class="btn btn-square btn-ghost btn-sm text-white"
				aria-label="Download"
				title="Download"
			>
				<Download size={18} />
			</a>
			<button
				type="button"
				bind:this={closeButton}
				class="btn btn-square btn-ghost btn-sm text-white"
				onclick={onclose}
				aria-label="Close"
				title="Close"
			>
				<X size={18} />
			</button>
		</div>
	</div>

	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div
		class="relative flex min-h-0 flex-1 items-center justify-center p-2"
		onclick={onBackdropClick}
		onpointerdown={onPointerDown}
		onpointerup={onPointerUp}
		onpointercancel={() => (startX = null)}
	>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
		<img
			src={current.src}
			alt={current.name}
			class="max-h-full max-w-full object-contain"
			draggable="false"
			onclick={(e) => e.stopPropagation()}
		/>
		{#if count > 1}
			<button
				type="button"
				class="btn btn-circle btn-ghost absolute left-2 text-white"
				onclick={(e) => {
					e.stopPropagation();
					prev();
				}}
				aria-label="Previous image"
			>
				<ChevronLeft size={24} />
			</button>
			<button
				type="button"
				class="btn btn-circle btn-ghost absolute right-2 text-white"
				onclick={(e) => {
					e.stopPropagation();
					next();
				}}
				aria-label="Next image"
			>
				<ChevronRight size={24} />
			</button>
		{/if}
	</div>
</div>
