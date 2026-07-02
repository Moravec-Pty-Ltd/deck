<script lang="ts">
	import { onMount } from 'svelte';
	import type { QuickMessage } from '$lib/types';
	import { dismissOnOutside } from '$lib/dismiss';
	import { MessageSquareText, Plus, Trash2, ArrowUp, ArrowDown, Settings2 } from '@lucide/svelte';

	// The composer's quick-message popover (issue #45): a button next to send that
	// lists the system-wide canned messages; clicking one fires it immediately via
	// `onpick`, which sends it with server-side [token] expansion. A "Manage" entry
	// opens a modal to add/edit/remove/reorder the list, persisted through
	// GET/PUT /api/quick-messages.
	let { onpick }: { onpick: (text: string) => void } = $props();

	type Draft = { id: string; label: string; text: string };

	let messages = $state<QuickMessage[]>([]);
	let open = $state(false);
	let managing = $state(false);
	let draft = $state<Draft[]>([]);
	let saving = $state(false);
	let err = $state('');

	onMount(load);

	async function load() {
		try {
			const res = await fetch('/api/quick-messages');
			if (res.ok) messages = await res.json();
		} catch {
			// best-effort; an empty list just shows the empty state
		}
	}

	// Local-only id for keyed-each + reorder; the server treats it as opaque, and
	// crypto.randomUUID needs a secure context deck may not have over plain http.
	function newId(): string {
		return `qm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	}

	function menuLabel(m: QuickMessage): string {
		if (m.label) return m.label;
		return m.text.length > 48 ? `${m.text.slice(0, 47)}…` : m.text;
	}

	function pick(m: QuickMessage) {
		open = false;
		onpick(m.text);
	}

	function openManage() {
		draft = messages.map((m) => ({ id: m.id, label: m.label ?? '', text: m.text }));
		err = '';
		open = false;
		managing = true;
	}

	function add() {
		draft = [...draft, { id: newId(), label: '', text: '' }];
	}

	function remove(i: number) {
		draft = draft.filter((_, k) => k !== i);
	}

	function move(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= draft.length) return;
		const next = [...draft];
		[next[i], next[j]] = [next[j], next[i]];
		draft = next;
	}

	async function save() {
		saving = true;
		err = '';
		const payload = draft
			.map((m) => ({ id: m.id, label: m.label.trim() || undefined, text: m.text.trim() }))
			.filter((m) => m.text);
		try {
			const res = await fetch('/api/quick-messages', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				err = 'save failed';
				return;
			}
			messages = await res.json();
			managing = false;
		} catch {
			err = 'network error';
		} finally {
			saving = false;
		}
	}

</script>

<details class="dropdown dropdown-top dropdown-end" bind:open use:dismissOnOutside={() => (open = false)}>
	<summary
		class="btn btn-ghost btn-square list-none [&::-webkit-details-marker]:hidden"
		aria-label="Quick messages"
		title="Quick messages"
	>
		<MessageSquareText size={16} />
	</summary>

	<div
		class="dropdown-content z-20 mb-1 w-64 rounded-box border border-base-300 bg-base-100 p-2 text-sm shadow-lg"
	>
		{#if messages.length}
			<ul class="menu menu-sm max-h-64 w-full flex-nowrap overflow-y-auto p-0">
				{#each messages as m (m.id)}
					<li>
						<button class="block truncate text-left" onclick={() => pick(m)}>{menuLabel(m)}</button>
					</li>
				{/each}
			</ul>
			<div class="mt-1 border-t border-base-300 pt-1">
				<button class="btn btn-ghost btn-xs w-full justify-start gap-2" onclick={openManage}>
					<Settings2 size={14} /> Manage
				</button>
			</div>
		{:else}
			<div class="px-1 py-3 text-center">
				<p class="mb-2 text-xs opacity-70">No quick messages yet.</p>
				<button class="btn btn-primary btn-xs gap-1" onclick={openManage}>
					<Plus size={14} /> Add messages
				</button>
			</div>
		{/if}
	</div>
</details>

{#if managing}
	<div class="modal modal-open" role="dialog">
		<div class="modal-box max-w-lg">
			<h3 class="mb-1 text-lg font-semibold">Quick messages</h3>
			<p class="mb-4 text-xs opacity-70">
				Canned messages for the composer. Text can include tokens like
				<code>[pr_url]</code>, <code>[branch-name]</code>, <code>[issue_url]</code>, expanded against
				the session when sent.
			</p>

			<div class="flex flex-col gap-2">
				{#each draft as m, i (m.id)}
					<div class="flex items-start gap-2 rounded-box border border-base-300 p-2">
						<div class="flex flex-col gap-1 pt-1">
							<button
								class="btn btn-square btn-ghost btn-xs"
								onclick={() => move(i, -1)}
								disabled={i === 0}
								aria-label="Move up"
							>
								<ArrowUp size={14} />
							</button>
							<button
								class="btn btn-square btn-ghost btn-xs"
								onclick={() => move(i, 1)}
								disabled={i === draft.length - 1}
								aria-label="Move down"
							>
								<ArrowDown size={14} />
							</button>
						</div>
						<div class="flex flex-1 flex-col gap-1">
							<input class="input input-sm w-full" placeholder="Label (optional)" bind:value={m.label} />
							<textarea
								class="textarea textarea-sm w-full"
								rows="2"
								placeholder="Message text"
								bind:value={m.text}
							></textarea>
						</div>
						<button
							class="btn btn-square btn-ghost btn-xs text-error"
							onclick={() => remove(i)}
							aria-label="Remove"
						>
							<Trash2 size={14} />
						</button>
					</div>
				{/each}
				{#if !draft.length}
					<p class="py-2 text-center text-sm opacity-60">No messages. Add one to get started.</p>
				{/if}
			</div>

			<button class="btn btn-ghost btn-sm mt-2 gap-2" onclick={add}>
				<Plus size={14} /> Add message
			</button>

			{#if err}<p class="mt-2 text-xs text-error">{err}</p>{/if}

			<div class="modal-action">
				<button class="btn btn-ghost" onclick={() => (managing = false)}>Cancel</button>
				<button class="btn btn-primary" onclick={save} disabled={saving}>
					{#if saving}<span class="loading loading-spinner loading-xs"></span>{/if} Save
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (managing = false)} aria-label="close"></button>
	</div>
{/if}
