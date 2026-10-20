import { mount } from 'svelte';
import { ConfirmQueue, type ConfirmOptions } from '$lib/confirm-core';
import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

export type { ConfirmOptions };

export class ConfirmState {
	current = $state<ConfirmOptions | null>(null);
	readonly queue = new ConfirmQueue((c) => (this.current = c));
}

const state = new ConfirmState();

// The dialog mounts itself on first use rather than from the layout, so any page
// can await a confirm without wiring a host component in.
let mounted = false;

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
	if (!mounted) {
		mount(ConfirmDialog, { target: document.body, props: { state } });
		mounted = true;
	}
	return state.queue.ask(options);
}
