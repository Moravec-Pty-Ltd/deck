<script lang="ts">
	import { TriangleAlert } from '@lucide/svelte';
	import type { ConfirmState } from '$lib/confirm.svelte';
	import Modal from './Modal.svelte';

	// Mounted once by confirmAction; see confirm.svelte.ts.
	let { state }: { state: ConfirmState } = $props();

	let c = $derived(state.current);
	const settle = (ok: boolean) => state.queue.settle(ok);
</script>

<Modal
	open={!!c}
	onclose={() => settle(false)}
	title={c?.title ?? ''}
	icon={c?.danger ? TriangleAlert : undefined}
	iconClass="text-error"
>
	{#if c?.body}<p class="text-sm opacity-70">{c.body}</p>{/if}
	{#snippet footer()}
		<button class="btn" onclick={() => settle(false)}>{c?.cancelLabel ?? 'Cancel'}</button>
		<button class="btn {c?.danger ? 'btn-error' : 'btn-primary'}" onclick={() => settle(true)}>
			{c?.confirmLabel ?? 'Confirm'}
		</button>
	{/snippet}
</Modal>
