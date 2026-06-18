<script lang="ts">
	import type { DeckSession, Project } from '$lib/types';
	import { deriveGroup } from '$lib/time';
	import { Plus, Terminal, Bot, GitBranch, FolderGit2, Trash2 } from '@lucide/svelte';

	interface Props {
		projects: Project[];
		sessions: DeckSession[];
		currentId?: string;
		deletingId?: string | null;
		onQuickAdd: (path: string) => void;
		onShellHere: (session: DeckSession) => void;
		onDelete: (session: DeckSession) => void;
	}
	let { projects, sessions, currentId, deletingId, onQuickAdd, onShellHere, onDelete }: Props =
		$props();

	const projectPaths = $derived(new Set(projects.map((p) => p.path)));

	// Status dot colour, mirroring the badge palette on the home page.
	function dotClass(s: DeckSession) {
		if (s.status === 'running') return 'bg-warning';
		if (s.status === 'error') return 'bg-error';
		if (s.status === 'dead') return 'bg-base-content/30';
		return 'bg-success';
	}

	// Group every session under its derived project (worktrees fold back to their
	// repo), most-recently-active group first — a switcher across all sessions.
	const groups = $derived.by(() => {
		const map = new Map<string, { key: string; label: string; sessions: DeckSession[] }>();
		for (const s of sessions) {
			const { key, label } = deriveGroup(s.cwd, projects);
			if (!map.has(key)) map.set(key, { key, label, sessions: [] });
			map.get(key)!.sessions.push(s);
		}
		return [...map.values()].sort((a, b) => b.sessions[0].lastActiveAt - a.sessions[0].lastActiveAt);
	});
</script>

<div class="flex items-center gap-2 px-2 pb-2">
	<FolderGit2 size={15} class="opacity-60" />
	<span class="text-sm font-semibold">Sessions</span>
</div>

<nav class="space-y-3">
	{#each groups as g (g.key)}
		<div>
			<div class="flex items-center gap-1 px-1">
				<span class="min-w-0 flex-1 truncate text-xs font-semibold opacity-70" title={g.key}>
					{g.label}
				</span>
				{#if projectPaths.has(g.key)}
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onQuickAdd(g.key)}
						aria-label={`New session in ${g.label}`}
						title="New session here"
					>
						<Plus size={14} />
					</button>
				{/if}
			</div>
			<ul class="mt-0.5 space-y-0.5">
				{#each g.sessions as s (s.id)}
					<li class="flex items-center gap-1">
						<a
							href={`/s/${encodeURIComponent(s.id)}`}
							class="flex min-w-0 flex-1 items-center gap-1.5 rounded-btn px-2 py-1 hover:bg-base-200 {s.id ===
							currentId
								? 'bg-primary/10 font-medium text-primary'
								: ''}"
							title={s.title}
						>
							{#if s.kind === 'shell'}
								<Terminal size={13} class="shrink-0 opacity-60" />
							{:else}
								<Bot size={13} class="shrink-0 opacity-60" />
							{/if}
							<span
								class="size-1.5 shrink-0 rounded-full {dotClass(s)}"
								title={s.status}
							></span>
							<span class="min-w-0 flex-1 truncate text-sm">{s.title}</span>
							{#if s.worktree}
								<GitBranch size={11} class="shrink-0 opacity-40" />
							{/if}
						</a>
						{#if s.kind !== 'shell' && s.worktree}
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => onShellHere(s)}
								aria-label={`Shell in ${s.worktree?.branch}`}
								title="Shell in this worktree"
							>
								<Terminal size={12} />
							</button>
						{/if}
						{#if s.id !== currentId}
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => onDelete(s)}
								disabled={deletingId === s.id}
								aria-label={`Remove ${s.title}`}
								title="Remove session"
							>
								{#if deletingId === s.id}
									<span class="loading loading-spinner loading-xs"></span>
								{:else}
									<Trash2 size={12} />
								{/if}
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/each}

	{#if groups.length === 0}
		<p class="px-2 py-1 text-xs opacity-50">No sessions yet.</p>
	{/if}
</nav>
