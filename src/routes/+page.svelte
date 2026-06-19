<script lang="ts">
	import type { DeckSession, NewSessionPreset, Project, SessionKind } from '$lib/types';
	import { relativeTime, shortPath, deriveGroup } from '$lib/time';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import { Bot, Terminal, Plus, Trash2, RefreshCw, FolderGit2, List, FolderCog } from '@lucide/svelte';

	let sessions = $state<DeckSession[]>([]);
	let projects = $state<Project[]>([]);
	let filter = $state<'all' | SessionKind>('all');
	let grouped = $state(true);
	let modalOpen = $state(false);
	let preset = $state<NewSessionPreset | null>(null);
	let loaded = $state(false);

	function openNew() {
		preset = null;
		modalOpen = true;
	}

	function quickAdd(path: string) {
		preset = projects.some((p) => p.path === path) ? { projectPath: path } : { cwd: path };
		modalOpen = true;
	}

	async function refresh() {
		const [sRes, pRes] = await Promise.all([fetch('/api/sessions'), fetch('/api/projects')]);
		if (sRes.ok) sessions = await sRes.json();
		if (pRes.ok) projects = await pRes.json();
		loaded = true;
	}

	$effect(() => {
		refresh();
		const interval = setInterval(refresh, 5000);
		return () => clearInterval(interval);
	});

	const visible = $derived(filter === 'all' ? sessions : sessions.filter((s) => s.kind === filter));

	// Only surface filter buttons for kinds that actually have sessions.
	const filterKinds = $derived(
		(['claude', 'pi', 'codex', 'shell'] as SessionKind[]).filter((k) =>
			sessions.some((s) => s.kind === k)
		)
	);

	// Group sessions by derived project, ordered by each group's most recent session.
	const groups = $derived.by(() => {
		const map = new Map<string, { label: string; sessions: DeckSession[] }>();
		for (const s of visible) {
			const { key, label } = deriveGroup(s.cwd, projects);
			if (!map.has(key)) map.set(key, { label, sessions: [] });
			map.get(key)!.sessions.push(s);
		}
		return [...map.entries()]
			.map(([key, g]) => ({ key, ...g }))
			.sort((a, b) => b.sessions[0].lastActiveAt - a.sessions[0].lastActiveAt);
	});

	let delTarget = $state<DeckSession | null>(null);
	let delWorktree = $state(true);
	let delBranch = $state(true);
	let deletingId = $state<string | null>(null);

	function remove(session: DeckSession, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		if (deletingId) return;
		if (session.worktree) {
			delWorktree = true;
			delBranch = session.worktree.createdBranch;
			delTarget = session;
			return;
		}
		if (!confirm(`Kill and remove "${session.title}"?`)) return;
		doDelete(session, {});
	}

	async function doDelete(
		session: DeckSession,
		opts: { deleteWorktree?: boolean; deleteBranch?: boolean }
	) {
		if (deletingId) return;
		deletingId = session.id;
		try {
			await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
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

	// Status as a quiet dot + label. Saturated colour is reserved for the states
	// that want attention (running = brand orange, error = red); idle and dead stay
	// neutral so a list at rest reads calm. Solid vs hollow keeps idle and dead
	// apart under e-ink, where colour collapses to monochrome.
	function statusDot(s: DeckSession) {
		if (s.status === 'running') return 'bg-primary';
		if (s.status === 'error') return 'bg-error';
		if (s.status === 'dead') return 'border border-base-content/40';
		return 'bg-base-content/35';
	}
	function statusText(s: DeckSession) {
		if (s.status === 'running') return 'font-medium text-primary';
		if (s.status === 'error') return 'font-medium text-error';
		if (s.status === 'dead') return 'text-base-content/40';
		return 'text-base-content/55';
	}
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
	<div class="flex items-center gap-2">
		<div class="join">
			{#each ['all', ...filterKinds] as f (f)}
				<button
					class="btn join-item btn-sm {filter === f ? 'btn-active' : ''}"
					onclick={() => (filter = f as 'all' | SessionKind)}
				>
					{f}
				</button>
			{/each}
		</div>
		<button
			class="btn btn-ghost btn-sm"
			onclick={() => (grouped = !grouped)}
			title={grouped ? 'Flat list' : 'Group by project'}
			aria-label="Toggle grouping"
		>
			{#if grouped}<FolderGit2 size={16} />{:else}<List size={16} />{/if}
		</button>
	</div>
	<div class="flex items-center gap-2">
		<a href="/projects" class="btn btn-ghost btn-sm" aria-label="Manage projects" title="Projects">
			<FolderCog size={16} />
		</a>
		<button class="btn btn-ghost btn-sm" onclick={refresh} aria-label="Refresh">
			<RefreshCw size={16} />
		</button>
		<button class="btn btn-sm btn-primary" onclick={openNew}>
			<Plus size={16} /> New
		</button>
	</div>
</div>

{#snippet row(s: DeckSession)}
	<a
		href={`/s/${encodeURIComponent(s.id)}`}
		class="flex items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-3 hover:border-base-content/30 sm:gap-3 sm:px-4"
	>
		{#if s.kind === 'shell'}
			<Terminal size={18} class="shrink-0 opacity-70" />
		{:else}
			<Bot size={18} class="shrink-0 opacity-70" />
		{/if}
		<div class="min-w-0 flex-1">
			<div class="truncate font-medium">{s.title}</div>
			<div class="truncate text-xs opacity-60">{shortPath(s.cwd)}</div>
		</div>
		{#if s.kind === 'pi' || s.kind === 'codex'}
			<span class="badge badge-ghost badge-sm">{s.kind}</span>
		{/if}
		{#if s.kind === 'shell' && s.attached}
			<span class="badge badge-outline badge-sm">attached</span>
		{/if}
		{#if s.managed === false}
			<span class="badge badge-ghost badge-sm">adhoc</span>
		{/if}
		<span class="flex shrink-0 items-center gap-1.5">
			<span class="size-2 shrink-0 rounded-full {statusDot(s)}"></span>
			<span class="text-xs {statusText(s)}">{s.status}</span>
		</span>
		<span class="w-10 text-right text-xs tabular-nums opacity-60">{relativeTime(s.lastActiveAt)}</span>
		<button
			class="btn btn-ghost btn-xs"
			onclick={(e) => remove(s, e)}
			disabled={deletingId === s.id}
			aria-label="Remove session"
		>
			{#if deletingId === s.id}
				<span class="loading loading-spinner loading-xs"></span>
			{:else}
				<Trash2 size={14} />
			{/if}
		</button>
	</a>
{/snippet}

{#if !loaded}
	<p class="p-8 text-center opacity-60">Loading sessions...</p>
{:else if visible.length === 0}
	<div class="rounded-box border border-base-300 bg-base-100 p-10 text-center opacity-70">
		No sessions yet. Create one to get started.
	</div>
{:else if grouped}
	<div class="space-y-5">
		{#each groups as g (g.key)}
			<section>
				<div class="mb-1.5 flex items-center gap-2 px-1">
					<FolderGit2 size={14} class="shrink-0 opacity-50" />
					<h2 class="font-semibold">{g.label}</h2>
					<span class="text-xs opacity-50">{g.sessions.length}</span>
					<span class="min-w-0 truncate text-xs opacity-40">{shortPath(g.key)}</span>
					<button
						class="btn btn-ghost btn-xs ml-auto shrink-0"
						onclick={() => quickAdd(g.key)}
						aria-label={`New session in ${g.label}`}
						title="New session here"
					>
						<Plus size={15} class="text-primary" />
					</button>
				</div>
				<ul class="space-y-2">
					{#each g.sessions as s (s.id)}
						<li>{@render row(s)}</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
{:else}
	<ul class="space-y-2">
		{#each visible as s (s.id)}
			<li>{@render row(s)}</li>
		{/each}
	</ul>
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
