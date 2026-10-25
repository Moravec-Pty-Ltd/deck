<script lang="ts">
	import { ChevronLeft, ChevronRight, Download, X } from '@lucide/svelte';
	import { FITTED, clampView, toggleZoom, wheelFactor, zoomAt, type ZoomView } from '$lib/zoom-core';

	// A message's images at full size, one at a time: arrows, the arrow keys, or
	// a swipe move between them, Escape or the backdrop closes. Opened by
	// FileAttachments at the image that was clicked. The wheel or a pinch zooms
	// at the pointer, a double-click or double-tap zooms in or back to fit, and a
	// drag pans a zoomed image; swiping to the next image works only when fitted.
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

	let view = $state<ZoomView>(FITTED);
	const zoomed = $derived(view.scale > 1);
	let stage: HTMLDivElement | undefined = $state();
	let img: HTMLImageElement | undefined = $state();

	// A new image starts fitted.
	$effect(() => {
		void index;
		view = FITTED;
	});

	function prev() {
		index = (index - 1 + count) % count;
	}
	function next() {
		index = (index + 1) % count;
	}

	// The pointer relative to the stage centre, where the fitted image sits.
	function local(clientX: number, clientY: number) {
		const r = stage!.getBoundingClientRect();
		return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
	}

	function apply(next: ZoomView) {
		if (!stage || !img) return;
		// offsetWidth/Height are the fitted size; the transform doesn't change them.
		view = clampView(next, { w: stage.clientWidth, h: stage.clientHeight }, { w: img.offsetWidth, h: img.offsetHeight });
	}

	function zoomBy(factor: number) {
		apply(zoomAt(view, factor, 0, 0));
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
		else if (e.key === 'ArrowLeft' && count > 1) prev();
		else if (e.key === 'ArrowRight' && count > 1) next();
		else if (e.key === '+' || e.key === '=') zoomBy(1.25);
		else if (e.key === '-') zoomBy(0.8);
		else if (e.key === '0') view = FITTED;
		else return;
		e.preventDefault();
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const p = local(e.clientX, e.clientY);
		apply(zoomAt(view, wheelFactor(e.deltaY, e.deltaMode), p.x, p.y));
	}

	// Some touch browsers also send dblclick for a double-tap the pointer code
	// already handled, so a second toggle within half a second is dropped.
	let toggledAt = 0;
	function onDoubleClick(e: MouseEvent) {
		const now = performance.now();
		if (now - toggledAt < 500) return;
		toggledAt = now;
		const p = local(e.clientX, e.clientY);
		apply(toggleZoom(view, p.x, p.y));
	}

	// Pointers down on the stage: one drags (pans when zoomed, swipes when fitted),
	// two pinch. `moved` keeps a drag's release from counting as a backdrop tap.
	const pointers = new Map<number, { x: number; y: number }>();
	let startX: number | null = null;
	let moved = false;
	let lastTap = { time: 0, x: 0, y: 0 };

	function pinchSpan() {
		const [a, b] = [...pointers.values()];
		return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
	}

	function onPointerDown(e: PointerEvent) {
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			startX = e.clientX;
			moved = false;
		} else startX = null;
	}

	function onPointerMove(e: PointerEvent) {
		const prevPoint = pointers.get(e.pointerId);
		if (!prevPoint) return;
		if (pointers.size === 2) {
			const before = pinchSpan();
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			const after = pinchSpan();
			const p = local(after.cx, after.cy);
			const z = zoomAt(view, before.d ? after.d / before.d : 1, p.x, p.y);
			apply({ ...z, x: z.x + after.cx - before.cx, y: z.y + after.cy - before.cy });
			moved = true;
			return;
		}
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const dx = e.clientX - prevPoint.x;
		const dy = e.clientY - prevPoint.y;
		if (Math.abs(e.clientX - (startX ?? e.clientX)) > 5 || Math.abs(dy) > 5) moved = true;
		if (zoomed) apply({ ...view, x: view.x + dx, y: view.y + dy });
	}

	function onPointerUp(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (startX === null || pointers.size) return;
		const dx = e.clientX - startX;
		startX = null;
		if (!zoomed && count > 1 && Math.abs(dx) >= 40) {
			moved = true;
			if (dx < 0) next();
			else prev();
			return;
		}
		// Touch has no reliable dblclick once the page's own zoom is off, so two
		// taps close together in time and place count as one here.
		if (e.pointerType !== 'mouse' && !moved) {
			const now = performance.now();
			if (now - lastTap.time < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
				onDoubleClick(e);
				lastTap.time = 0;
				moved = true;
			} else lastTap = { time: now, x: e.clientX, y: e.clientY };
		}
	}

	function onPointerCancel(e: PointerEvent) {
		pointers.delete(e.pointerId);
		startX = null;
	}

	// A tap on the backdrop closes, unless it ended a drag, pinch or double-tap.
	// On touch the close waits out the double-tap window.
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	function onBackdropClick(e: MouseEvent) {
		if (moved) return;
		clearTimeout(closeTimer);
		if ((e as PointerEvent).pointerType === 'mouse' || e.detail === 0) onclose();
		else closeTimer = setTimeout(() => !moved && onclose(), 320);
	}
	$effect(() => () => clearTimeout(closeTimer));

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
		<div class="flex shrink-0 items-center gap-1">
			{#if zoomed}
				<button
					type="button"
					class="btn btn-ghost btn-sm text-white tabular-nums"
					onclick={() => (view = FITTED)}
					aria-label="Zoomed to {Math.round(view.scale * 100)}%. Fit to screen"
					title="Fit to screen (0)"
				>
					{Math.round(view.scale * 100)}%
				</button>
			{/if}
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
		bind:this={stage}
		class="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-2"
		onclick={onBackdropClick}
		ondblclick={onDoubleClick}
		onwheel={onWheel}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerCancel}
	>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
		<img
			bind:this={img}
			src={current.src}
			alt={current.name}
			class="max-h-full max-w-full object-contain {zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}"
			style="transform: translate({view.x}px, {view.y}px) scale({view.scale})"
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
