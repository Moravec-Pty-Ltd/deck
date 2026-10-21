<script lang="ts">
	import Modal from './Modal.svelte';
	import { onMount } from 'svelte';
	import type { Project, QuickMessage } from '$lib/types';
	import { MessageSquareText, Plus, Trash2, ArrowUp, ArrowDown, Settings2 } from '@lucide/svelte';
	import Popover from './Popover.svelte';
	import { AgentApiError, agentGet, agentPath, agentRequest } from '$lib/agent-api';
	import { groupByScope, moveWithinScope, quickMessagesFor, setScope } from '$lib/quick-messages-core';

	// The composer's quick-message popover (issue #45): a button next to send that
	// lists the session's project's canned messages and then the global ones;
	// clicking one fires it immediately via `onpick`, which sends it with
	// server-side [token] expansion. A "Manage" entry opens a modal to add, edit,
	// remove, reorder and rescope the list, persisted through
	// GET/PUT /api/agent/quick-messages. `projectId` is the session's registered
	// project path, absent outside every project.
	let {
		onpick,
		projectId,
		projects = []
	}: { onpick: (text: string) => void; projectId?: string; projects?: Project[] } = $props();

	type Draft = { id: string; label: string; text: string; projectId?: string };

	let messages = $state<QuickMessage[]>([]);
	let open = $state(false);
	let managing = $state(false);
	let draft = $state<Draft[]>([]);
	let saving = $state(false);
	let err = $state('');
	let addScope = $state('');

	const shown = $derived(quickMessagesFor(messages, projectId));
	const groups = $derived(groupByScope(draft, projects));

	onMount(load);

	async function load() {
		try {
			messages = await agentGet<QuickMessage[]>(agentPath('quick-messages'));
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
		draft = messages.map((m) => ({ id: m.id, label: m.label ?? '', text: m.text, projectId: m.projectId }));
		addScope = projectId ?? '';
		err = '';
		open = false;
		managing = true;
	}

	function add() {
		draft = [...draft, { id: newId(), label: '', text: '', projectId: addScope || undefined }];
	}

	function remove(i: number) {
		draft = draft.filter((_, k) => k !== i);
	}

	function move(i: number, dir: -1 | 1) {
		draft = moveWithinScope(draft, i, dir);
	}

	function rescope(i: number, scope: string) {
		draft = setScope(draft, i, scope);
	}

	// A message scoped to a project that is no longer registered keeps its path
	// as an option, so opening the editor never silently rescopes it.
	function scopeOptions(current?: string): { value: string; label: string }[] {
		const options = [{ value: '', label: 'Global' }, ...projects.map((p) => ({ value: p.path, label: p.name }))];
		if (current && !projects.some((p) => p.path === current)) options.push({ value: current, label: current });
		return options;
	}

	async function save() {
		saving = true;
		err = '';
		const payload = draft
			.map((m) => ({
				id: m.id,
				label: m.label.trim() || undefined,
				text: m.text.trim(),
				projectId: m.projectId || undefined
			}))
			.filter((m) => m.text);
		try {
			messages = await agentRequest<QuickMessage[]>(agentPath('quick-messages'), { method: 'PUT', body: payload });
			managing = false;
		} catch (e) {
			err = e instanceof AgentApiError ? 'Save failed' : 'Network error';
		} finally {
			saving = false;
		}
	}

</script>

<Popover
	bind:open
	direction="top"
	summaryClass="btn btn-ghost btn-square"
	summaryLabel="Quick messages"
	summaryTitle="Quick messages"
	panelClass="p-2 sm:w-64"
>
	{#snippet trigger()}
		<MessageSquareText size={16} />
	{/snippet}
	{#if shown.length}
		<ul class="menu menu-sm max-h-64 w-full flex-nowrap overflow-y-auto p-0">
			{#each shown as m (m.id)}
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
</Popover>

<Modal open={managing} onclose={() => (managing = false)} title="Quick messages" class="max-w-lg">
	<p class="-mt-2 mb-4 text-xs opacity-70">
		Canned messages for the composer. Text can include tokens like
		<code>[pr_url]</code>, <code>[branch-name]</code>, <code>[issue_url]</code>, expanded against
		the session when sent.
	</p>

	<div class="flex flex-col gap-4">
		{#each groups as group (group.projectId ?? '')}
			<section class="flex flex-col gap-2" aria-label={group.label}>
				<h3 class="text-xs font-semibold uppercase tracking-wide opacity-70">{group.label}</h3>
				{#each group.items as { message: m, index: i }, k (m.id)}
					<div class="flex items-start gap-2 rounded-box border border-base-300 p-2">
						<div class="flex flex-col gap-1 pt-1">
							<button
								class="btn btn-square btn-ghost btn-xs"
								onclick={() => move(i, -1)}
								disabled={k === 0}
								aria-label="Move up"
							>
								<ArrowUp size={14} />
							</button>
							<button
								class="btn btn-square btn-ghost btn-xs"
								onclick={() => move(i, 1)}
								disabled={k === group.items.length - 1}
								aria-label="Move down"
							>
								<ArrowDown size={14} />
							</button>
						</div>
						<div class="flex flex-1 flex-col gap-1">
							<input class="input input-sm w-full" placeholder="Label (optional)" bind:value={draft[i].label} />
							<textarea
								class="textarea textarea-sm w-full"
								rows="2"
								placeholder="Message text"
								bind:value={draft[i].text}
							></textarea>
							<select
								class="select select-xs w-full"
								aria-label="Show in"
								value={m.projectId ?? ''}
								onchange={(e) => rescope(i, e.currentTarget.value)}
							>
								{#each scopeOptions(m.projectId) as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
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
				{#if !group.items.length}
					<p class="py-1 text-center text-sm opacity-60">No global messages.</p>
				{/if}
			</section>
		{/each}
	</div>

	<div class="mt-3 flex items-center gap-2">
		<button class="btn btn-ghost btn-sm gap-2" onclick={add}>
			<Plus size={14} /> Add message to
		</button>
		<select class="select select-sm flex-1" aria-label="Add to" bind:value={addScope}>
			{#each scopeOptions() as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
	</div>

	{#if err}<p class="mt-2 text-xs text-error">{err}</p>{/if}
	{#snippet footer()}
		<button class="btn btn-ghost" onclick={() => (managing = false)}>Cancel</button>
		<button class="btn btn-primary" onclick={save} disabled={saving}>
			{#if saving}<span class="loading loading-spinner loading-xs"></span>{/if} Save
		</button>
	{/snippet}
</Modal>
