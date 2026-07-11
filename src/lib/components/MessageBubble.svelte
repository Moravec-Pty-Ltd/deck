<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Copy, Check } from '@lucide/svelte';
	import Linked from './Linked.svelte';
	import { haptic } from '$lib/haptics';

	// A transcript message bubble (user / assistant / live) with a copy affordance:
	// a hover copy button on desktop, a long-press to copy on touch. Copies the raw
	// `text` verbatim. `children` renders before the text (e.g. a user message's
	// attached images).
	let {
		text = '',
		side,
		bubbleClass = '',
		children
	}: {
		text?: string;
		side: 'start' | 'end';
		bubbleClass?: string;
		children?: Snippet;
	} = $props();

	const copyable = $derived(!!text.trim());

	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	async function doCopy() {
		if (!copyable || !navigator.clipboard) return;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			return; // don't flash the "copied" tick if the write actually failed
		}
		copied = true;
		clearTimeout(resetTimer);
		resetTimer = setTimeout(() => (copied = false), 1000);
	}

	// Long-press to copy (touch only; mouse uses the hover button and keeps native
	// text selection). A still hold for ~500ms copies; movement past a threshold (a
	// scroll) or an early release (a tap) cancels it. The bubble suppresses the iOS
	// callout on touch via CSS so the press triggers our copy instead of selection.
	const LONG_PRESS_MS = 500;
	const MOVE_CANCEL_PX = 10;
	let pressTimer: ReturnType<typeof setTimeout> | undefined;
	let startX = 0;
	let startY = 0;

	function onPointerDown(e: PointerEvent) {
		if (e.pointerType !== 'touch' || !copyable) return;
		startX = e.clientX;
		startY = e.clientY;
		clearTimeout(pressTimer);
		pressTimer = setTimeout(() => {
			pressTimer = undefined;
			haptic();
			doCopy();
		}, LONG_PRESS_MS);
	}
	function onPointerMove(e: PointerEvent) {
		if (pressTimer === undefined) return;
		if (Math.abs(e.clientX - startX) > MOVE_CANCEL_PX || Math.abs(e.clientY - startY) > MOVE_CANCEL_PX) {
			cancelPress();
		}
	}
	function cancelPress() {
		clearTimeout(pressTimer);
		pressTimer = undefined;
	}

	$effect(() => () => {
		clearTimeout(pressTimer);
		clearTimeout(resetTimer);
	});
</script>

<div class="chat chat-{side}">
	<div
		class="chat-bubble bubble group relative max-w-[85%] break-words whitespace-pre-wrap {bubbleClass}"
		role="group"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={cancelPress}
		onpointercancel={cancelPress}
		onpointerleave={cancelPress}
	>
		{@render children?.()}
		{#if text}<Linked {text} />{/if}
		{#if copyable}
			<button
				type="button"
				class="copy-btn btn btn-ghost btn-xs absolute top-1 right-1 transition-opacity {copied
					? 'opacity-100'
					: 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'}"
				onclick={doCopy}
				aria-label="Copy message"
				title="Copy message"
			>
				{#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
			</button>
		{/if}
	</div>
</div>

<style>
	/* Keep the copy button legible over bubble text. */
	.copy-btn {
		background-color: color-mix(in oklch, var(--color-base-100) 70%, transparent);
	}
	/* On touch devices, suppress native selection + the iOS long-press callout so a
	   hold triggers our copy instead of the text-selection magnifier. Desktop keeps
	   selection (the hover button copies there). */
	@media (hover: none) and (pointer: coarse) {
		.bubble {
			-webkit-touch-callout: none;
			user-select: none;
			-webkit-user-select: none;
		}
	}
</style>
