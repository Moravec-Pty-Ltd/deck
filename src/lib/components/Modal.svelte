<script module lang="ts">
	// Shared with the dialogs that keep their own chrome (CommandPalette,
	// TranscriptSearch) so every dialog sits, sizes and animates the same way:
	// a bottom sheet below sm, a centred box above it.
	export const DIALOG_CLASS = 'modal modal-bottom sm:modal-middle';
</script>

<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import { X } from '@lucide/svelte';

	// The one modal primitive, a native <dialog> opened with showModal(): the
	// platform supplies the focus trap, Escape, the inert page behind it and
	// focus restore on close.
	//
	//   open         show it. One-way: the dialog never writes it back.
	//   onclose      the user dismissed it (Escape, backdrop, close button); set
	//                your open state false here. Not called when you close it by
	//                flipping `open` yourself.
	//   title        the heading, and the dialog's accessible name.
	//   icon         optional lucide icon before the title; iconClass colours it.
	//   class        box classes, usually a width (default max-w-sm).
	//   dismissible  false blocks Escape, the backdrop and the close button, e.g.
	//                while a request is in flight.
	//   children     the body. Mounted only while open, so its effects run per open.
	//   footer       actions, right-aligned under the body.
	//
	// The dialog itself takes focus on open, not its first field, so a phone
	// doesn't throw up the keyboard over a sheet the user only came to read.
	let {
		open,
		onclose,
		title,
		icon: Icon,
		iconClass = '',
		class: boxClass = 'max-w-sm',
		dismissible = true,
		children,
		footer
	}: {
		open: boolean;
		onclose: () => void;
		title: string;
		icon?: Component<{ size?: number; class?: string }>;
		iconClass?: string;
		class?: string;
		dismissible?: boolean;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	const titleId = $props.id();
	let dialog = $state<HTMLDialogElement>();

	$effect(() => {
		const d = dialog;
		if (!d) return;
		if (open && !d.open) {
			dismissed = false;
			d.showModal();
			d.focus();
		} else if (!open && d.open) {
			d.close();
		}
	});

	// Escape fires `cancel` and then `close`. Some engines never deliver the
	// `close`, which left the caller's open state stuck, so a dismissal is taken
	// from whichever arrives first and reported once.
	let dismissed = false;
	function dismiss() {
		if (!open || dismissed) return;
		dismissed = true;
		onclose();
	}

	function onCancel(e: Event) {
		if (!dismissible) e.preventDefault();
		else dismiss();
	}

	// A cancelled keydown never becomes a close request, which also covers
	// browsers that stop honouring preventDefault on a repeated cancel event.
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !dismissible) e.preventDefault();
	}
</script>

<dialog
	bind:this={dialog}
	class="{DIALOG_CLASS} deck-modal"
	aria-labelledby={titleId}
	tabindex="-1"
	onclose={dismiss}
	oncancel={onCancel}
	onkeydown={onKeydown}
>
	{#if open}
		<div class="modal-box deck-modal-box {boxClass}">
			<div class="mb-3 flex items-start justify-between gap-3">
				<h3 id={titleId} class="flex min-w-0 items-center gap-2 text-lg font-semibold">
					{#if Icon}<Icon size={18} class="shrink-0 {iconClass}" />{/if}
					<span class="min-w-0 break-words">{title}</span>
				</h3>
				<button
					class="btn btn-square btn-ghost btn-sm -my-0.5 shrink-0"
					onclick={onclose}
					disabled={!dismissible}
					aria-label="Close"
				>
					<X size={16} />
				</button>
			</div>
			{@render children()}
			{#if footer}
				<div class="modal-action">{@render footer()}</div>
			{/if}
		</div>
		<form method="dialog" class="modal-backdrop">
			<button tabindex="-1" disabled={!dismissible} aria-label="Close">close</button>
		</form>
	{/if}
</dialog>
