<script lang="ts">
	import type { PageProps } from './$types';
	import type { DeckSession, NewSessionPreset, Project } from '$lib/types';
	import ClaudeView from '$lib/components/ClaudeView.svelte';
	import ShellView from '$lib/components/ShellView.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import { shortPath } from '$lib/time';
	import { ISSUE_BADGE } from '$lib/issues';
	import { ArrowLeft, Bot, Terminal, Menu, X, Plus } from '@lucide/svelte';

	let { data }: PageProps = $props();
	const session = $derived(data.session);

	let projects = $state<Project[]>([]);
	let sessions = $state<DeckSession[]>([]);
	let modalOpen = $state(false);
	let preset = $state<NewSessionPreset | null>(null);
	let sidebarOpen = $state(false);

	async function refresh() {
		const [pRes, sRes] = await Promise.all([fetch('/api/projects'), fetch('/api/sessions')]);
		if (pRes.ok) projects = await pRes.json();
		if (sRes.ok) sessions = await sRes.json();
	}

	$effect(() => {
		refresh();
		const interval = setInterval(refresh, 5000);
		return () => clearInterval(interval);
	});

	function openNew() {
		preset = null;
		modalOpen = true;
	}
	function quickAdd(path: string) {
		preset = { projectPath: path };
		modalOpen = true;
		sidebarOpen = false;
	}
	function shellHere(s: DeckSession) {
		preset = { kind: 'shell', cwd: s.cwd, title: '' };
		modalOpen = true;
		sidebarOpen = false;
	}

	let delTarget = $state<DeckSession | null>(null);
	let delWorktree = $state(true);
	let delBranch = $state(true);
	let deletingId = $state<string | null>(null);

	function requestDelete(s: DeckSession) {
		if (deletingId) return;
		if (s.id === session.id) return; // never delete the active session
		if (s.worktree) {
			delWorktree = true;
			delBranch = s.worktree.createdBranch;
			delTarget = s;
			return;
		}
		if (!confirm(`Kill and remove "${s.title}"?`)) return;
		doDelete(s, {});
	}

	async function doDelete(
		s: DeckSession,
		opts: { deleteWorktree?: boolean; deleteBranch?: boolean }
	) {
		if (deletingId) return;
		deletingId = s.id;
		try {
			await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(opts)
			});
			delTarget = null;
			await refresh();
		} finally {
			deletingId = null;
		}
	}
</script>

<svelte:head>
	<title>{session.title} · deck</title>
</svelte:head>

{#snippet sidebar()}
	<Sidebar
		{projects}
		{sessions}
		currentId={session.id}
		{deletingId}
		onQuickAdd={quickAdd}
		onShellHere={shellHere}
		onDelete={requestDelete}
	/>
{/snippet}

<div class="flex h-full lg:gap-5">
	<aside class="hidden h-full overflow-y-auto lg:block lg:w-56 lg:shrink-0">
		{@render sidebar()}
	</aside>

	<div class="flex h-full min-w-0 flex-1 flex-col">
		<div class="mb-2 flex items-center gap-2">
			<a href="/" class="btn btn-ghost btn-sm shrink-0" aria-label="Back">
				<ArrowLeft size={16} />
			</a>
			<button
				class="btn btn-ghost btn-sm shrink-0 lg:hidden"
				onclick={() => (sidebarOpen = true)}
				aria-label="Open sessions"
			>
				<Menu size={16} />
			</button>
			{#if session.kind === 'shell'}
				<Terminal size={16} class="shrink-0 opacity-70" />
			{:else}
				<Bot size={16} class="shrink-0 opacity-70" />
			{/if}
			{#if session.kind !== 'claude' && session.kind !== 'shell'}
				<span class="badge badge-ghost badge-sm shrink-0">{session.kind}</span>
			{/if}
			<div class="flex min-w-0 flex-1 items-baseline gap-2">
				<span class="truncate font-medium">{session.title}</span>
				{#if session.issue}
					{#if session.issue.url}
						<a
							href={session.issue.url}
							target="_blank"
							rel="noopener noreferrer"
							class="badge badge-outline badge-sm link link-hover shrink-0 gap-1"
							title="{ISSUE_BADGE[session.issue.source].label} {session.issue.id}"
						>
							{ISSUE_BADGE[session.issue.source].label} {session.issue.id}
						</a>
					{:else}
						<span class="badge badge-outline badge-sm shrink-0 gap-1">
							{ISSUE_BADGE[session.issue.source].label} {session.issue.id}
						</span>
					{/if}
				{/if}
				<span class="hidden truncate text-xs opacity-60 sm:inline">{shortPath(session.cwd)}</span>
			</div>
			{#if session.kind === 'claude' && session.permissionMode === 'bypassPermissions'}
				<span class="badge badge-outline badge-sm shrink-0">yolo</span>
			{/if}
			<button class="btn btn-primary btn-sm shrink-0" onclick={openNew} aria-label="New session">
				<Plus size={16} /> <span class="hidden sm:inline">New</span>
			</button>
		</div>

		<div class="min-h-0 flex-1">
			{#if session.kind === 'shell'}
				<ShellView {session} />
			{:else}
				<ClaudeView {session} />
			{/if}
		</div>
	</div>
</div>

{#if sidebarOpen}
	<div class="fixed inset-0 z-40 lg:hidden">
		<button
			class="absolute inset-0 bg-black/40"
			onclick={() => (sidebarOpen = false)}
			aria-label="Close sessions"
		></button>
		<div class="absolute inset-y-0 left-0 w-72 max-w-[80%] overflow-y-auto bg-base-100 p-3 shadow-xl">
			<div class="mb-2 flex justify-end">
				<button class="btn btn-ghost btn-sm" onclick={() => (sidebarOpen = false)} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			{@render sidebar()}
		</div>
	</div>
{/if}

<NewSessionModal bind:open={modalOpen} {preset} />

{#if delTarget}
	<div class="modal modal-open" role="dialog">
		<div class="modal-box max-w-sm">
			<h3 class="mb-2 text-lg font-semibold">Remove "{delTarget.title}"</h3>
			<p class="mb-3 text-sm opacity-70">
				Kills the session. This session lives in a git worktree on branch
				<span class="font-mono">{delTarget.worktree?.branch}</span>.
			</p>
			<div class="space-y-2">
				<label class="label cursor-pointer justify-start gap-2">
					<input type="checkbox" class="checkbox checkbox-sm" bind:checked={delWorktree} />
					<span>Delete the worktree</span>
				</label>
				<label class="label cursor-pointer justify-start gap-2">
					<input
						type="checkbox"
						class="checkbox checkbox-sm"
						bind:checked={delBranch}
						disabled={!delWorktree || !delTarget.worktree?.createdBranch}
					/>
					<span>
						Delete the branch
						{#if !delTarget.worktree?.createdBranch}
							<span class="opacity-50">(existing branch, kept)</span>
						{/if}
					</span>
				</label>
			</div>
			<div class="modal-action">
				<button class="btn" onclick={() => (delTarget = null)} disabled={!!deletingId}>Cancel</button>
				<button
					class="btn btn-error"
					disabled={!!deletingId}
					onclick={() =>
						delTarget &&
						doDelete(delTarget, { deleteWorktree: delWorktree, deleteBranch: delBranch })}
				>
					{#if deletingId}
						<span class="loading loading-spinner loading-xs"></span> Removing...
					{:else}
						Remove
					{/if}
				</button>
			</div>
		</div>
		<button
			class="modal-backdrop"
			onclick={() => !deletingId && (delTarget = null)}
			aria-label="close"
		></button>
	</div>
{/if}
