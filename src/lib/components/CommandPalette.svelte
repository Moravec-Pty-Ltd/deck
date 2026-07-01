<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		buildCommands,
		filterCommands,
		type Command,
		type CommandContext,
		type MergeMethod,
		type PrActionPayload
	} from '$lib/commands';
	import type { DeckSession, ServerRuntime } from '$lib/types';
	import { fetchServers, serverAction as postServerAction } from '$lib/servers-client';
	import { Search, CornerDownLeft, ChevronLeft } from '@lucide/svelte';

	// Global Cmd+K palette. Rendered once in the layout; `open` is toggled by the
	// layout's keydown listener. Uses a native <dialog> so focus trapping, Escape,
	// and focus-restore-on-close come for free. Theme + notifications are threaded
	// in from the layout (which owns that state); everything else the palette wires
	// against the existing endpoints.
	let {
		open = $bindable(false),
		cycleTheme,
		notificationsSupported = false,
		toggleNotifications
	}: {
		open?: boolean;
		cycleTheme: () => void;
		notificationsSupported?: boolean;
		toggleNotifications: () => void;
	} = $props();

	let dialogEl = $state<HTMLDialogElement>();
	let inputEl = $state<HTMLInputElement>();
	let messageEl = $state<HTMLInputElement>();
	let mergeBtnEl = $state<HTMLButtonElement>();

	let query = $state('');
	let selected = $state(0);
	let sessions = $state<DeckSession[]>([]);
	let sessionServers = $state<ServerRuntime[]>([]);

	// Second-step panel: a command awaiting its input before it runs.
	let active = $state<Command | null>(null);
	let message = $state('');
	let method = $state<MergeMethod>('squash');
	let deleteBranch = $state(false);
	let busy = $state(false);
	let err = $state('');

	const currentId = $derived(page.url.pathname.startsWith('/s/') ? page.params.id : undefined);
	const currentSession = $derived(
		currentId ? (sessions.find((s) => s.id === currentId) ?? null) : null
	);

	async function prPost(payload: PrActionPayload) {
		if (!currentSession) throw new Error('no session');
		const res = await fetch(`/api/sessions/${encodeURIComponent(currentSession.id)}/pr`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!res.ok) {
			const data = await res.json().catch(() => null);
			throw new Error(data?.message || 'action failed');
		}
		await loadData();
	}

	async function prDismiss() {
		if (!currentSession) return;
		const res = await fetch(`/api/sessions/${encodeURIComponent(currentSession.id)}/pr`, {
			method: 'DELETE'
		});
		if (!res.ok) {
			const data = await res.json().catch(() => null);
			throw new Error(data?.message || 'action failed');
		}
		await loadData();
	}

	function context(): CommandContext {
		return {
			session: currentSession,
			sessions,
			servers: sessionServers,
			goto: (url) => goto(url),
			openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
			copy: (text) => navigator.clipboard?.writeText(text).catch(() => {}),
			cycleTheme,
			notificationsSupported,
			toggleNotifications,
			prAction: prPost,
			dismissPr: prDismiss,
			serverAction: async (name, action) => {
				if (!currentSession) return;
				await postServerAction(currentSession.id, name, action);
				await loadData();
			}
		};
	}

	const commands = $derived(buildCommands(context()));
	const filtered = $derived(filterCommands(commands, query));
	// Keep the highlight in range as the list narrows.
	const active_index = $derived(Math.min(selected, Math.max(0, filtered.length - 1)));

	// Pull the switch-list + current session's servers whenever the palette opens
	// (and after an action mutates them). Cheap and on-demand, no new poller.
	async function loadData() {
		const sRes = await fetch('/api/sessions').catch(() => null);
		if (sRes?.ok) sessions = await sRes.json();
		sessionServers = currentId ? await fetchServers(currentId).catch(() => []) : [];
	}

	// Drive the native dialog from `open`, resetting transient state on each open.
	$effect(() => {
		const d = dialogEl;
		if (!d) return;
		if (open && !d.open) {
			query = '';
			selected = 0;
			active = null;
			err = '';
			d.showModal();
			void loadData();
			inputEl?.focus();
		} else if (!open && d.open) {
			d.close();
		}
	});

	// Reset the highlight to the top whenever the query changes, and clear a stale
	// error from a prior failed action so it doesn't linger while you type on.
	$effect(() => {
		query;
		selected = 0;
		err = '';
	});

	function move(delta: number) {
		if (filtered.length === 0) return;
		selected = (active_index + delta + filtered.length) % filtered.length;
	}

	function choose(cmd: Command | undefined) {
		if (!cmd || busy) return;
		if (cmd.step) {
			active = cmd;
			err = '';
			message = '';
			method = 'squash';
			deleteBranch = false;
		} else {
			void execute(cmd);
		}
	}

	// Focus a step's primary control once it has rendered (effects run after the DOM
	// updates, so the binding is live). The merge step parks focus on the submit
	// button so Enter merges; the text step focuses the message field.
	$effect(() => {
		if (active?.step === 'text') messageEl?.focus();
		else if (active?.step === 'merge') mergeBtnEl?.focus();
	});

	const METHODS: MergeMethod[] = ['squash', 'merge', 'rebase'];
	function cycleMethod(delta: number) {
		method = METHODS[(METHODS.indexOf(method) + delta + METHODS.length) % METHODS.length];
	}

	// Left/right cycle the merge method while focus rests on the submit button;
	// Enter is the button's own default, keeping the merge step keyboard-only.
	function onMergeKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			e.preventDefault();
			cycleMethod(1);
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			e.preventDefault();
			cycleMethod(-1);
		}
	}

	async function execute(cmd: Command, input?: Parameters<Command['run']>[0]) {
		busy = true;
		err = '';
		try {
			await cmd.run(input);
			open = false;
		} catch (e) {
			err = e instanceof Error ? e.message : 'action failed';
		} finally {
			busy = false;
		}
	}

	function backToList() {
		active = null;
		err = '';
		inputEl?.focus();
	}

	function onListKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			move(1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			move(-1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			choose(filtered[active_index]);
		}
	}

	// Escape backs out of a step panel first, and only then closes the palette.
	function onCancel(e: Event) {
		if (active) {
			e.preventDefault();
			backToList();
		}
	}
</script>

<dialog
	bind:this={dialogEl}
	class="modal"
	aria-label="Command palette"
	oncancel={onCancel}
	onclose={() => (open = false)}
>
	<div class="modal-box w-full max-w-xl overflow-hidden p-0">
		{#if !active}
			<label class="flex items-center gap-2 border-b border-base-300 px-3">
				<Search size={16} class="shrink-0 opacity-50" />
				<input
					bind:this={inputEl}
					bind:value={query}
					onkeydown={onListKeydown}
					class="input input-ghost h-12 w-full border-0 px-0 focus:outline-none"
					placeholder="Type a command or search…"
					aria-label="Command"
					autocomplete="off"
					spellcheck="false"
				/>
			</label>
			<ul class="menu menu-sm max-h-80 w-full flex-nowrap overflow-y-auto p-2">
				{#each filtered as cmd, i (cmd.id)}
					<li>
						<button
							type="button"
							class="flex items-center gap-2 {i === active_index ? 'active' : ''}"
							onclick={() => {
								selected = i;
								choose(cmd);
							}}
							onmousemove={() => (selected = i)}
						>
							<span class="min-w-0 flex-1 truncate {cmd.danger ? 'text-error' : ''}">{cmd.title}</span>
							{#if cmd.hint}<span class="shrink-0 text-xs opacity-50">{cmd.hint}</span>{/if}
							{#if i === active_index}<CornerDownLeft size={13} class="shrink-0 opacity-40" />{/if}
						</button>
					</li>
				{:else}
					<li class="px-2 py-3 text-sm opacity-50">No matching commands.</li>
				{/each}
			</ul>
			{#if err}
				<p class="border-t border-base-300 px-3 py-2 text-xs text-error">{err}</p>
			{/if}
		{:else}
			<div class="flex flex-col gap-3 p-4">
				<div class="flex items-center gap-2">
					<button class="btn btn-ghost btn-xs gap-1" onclick={backToList}>
						<ChevronLeft size={12} /> Back
					</button>
					<span class="text-sm font-medium">{active.title}</span>
				</div>

				{#if active.step === 'text'}
					<input
						bind:this={messageEl}
						bind:value={message}
						onkeydown={(e) => {
							if (e.key === 'Enter' && message.trim()) {
								e.preventDefault();
								execute(active!, { text: message });
							}
						}}
						class="input input-bordered input-sm w-full"
						placeholder={active.placeholder ?? 'Message'}
						autocomplete="off"
					/>
					{#if err}<p class="text-xs text-error">{err}</p>{/if}
					<div class="flex justify-end">
						<button
							class="btn btn-primary btn-sm"
							onclick={() => execute(active!, { text: message })}
							disabled={busy || !message.trim()}
						>
							{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if} Submit
						</button>
					</div>
				{:else}
					<div class="join w-full">
						{#each [['squash', 'Squash'], ['merge', 'Merge'], ['rebase', 'Rebase']] as [value, label] (value)}
							<button
								class="btn join-item btn-sm flex-1 {method === value ? 'btn-active' : 'btn-ghost'}"
								onclick={() => (method = value as MergeMethod)}
							>
								{label}
							</button>
						{/each}
					</div>
					<label class="flex cursor-pointer items-center gap-2 text-sm">
						<input type="checkbox" class="checkbox checkbox-sm" bind:checked={deleteBranch} />
						Delete branch after merge
					</label>
					{#if err}<p class="text-xs text-error">{err}</p>{/if}
					<div class="flex justify-end">
						<button
							bind:this={mergeBtnEl}
							class="btn btn-primary btn-sm"
							onclick={() => execute(active!, { method, deleteBranch })}
							onkeydown={onMergeKeydown}
							disabled={busy}
						>
							{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if} Merge {method}
						</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>
	<form method="dialog" class="modal-backdrop">
		<button aria-label="Close">close</button>
	</form>
</dialog>
