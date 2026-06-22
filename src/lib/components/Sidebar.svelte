<script lang="ts">
	import type { DeckSession, Project, ServerState } from '$lib/types';
	import { groupSessions } from '$lib/groups';
	import { createCollapseState } from '$lib/collapse.svelte';
	import { aggregateState, SERVER_DOT, SERVER_LABEL } from '$lib/servers';
	import { Plus, Terminal, Bot, GitBranch, FolderGit2, Trash2, ChevronRight, ChevronDown } from '@lucide/svelte';

	interface Props {
		projects: Project[];
		sessions: DeckSession[];
		serverStates?: Record<string, ServerState[]>;
		currentId?: string;
		deletingId?: string | null;
		onQuickAdd: (path: string) => void;
		onShellHere: (session: DeckSession) => void;
		onDelete: (session: DeckSession) => void;
	}
	let { projects, sessions, serverStates, currentId, deletingId, onQuickAdd, onShellHere, onDelete }: Props =
		$props();

	// Aggregate dev-server state for a session, or null when it runs none (issue #32).
	function serverDot(id: string): ServerState | null {
		return aggregateState(serverStates?.[id] ?? []);
	}

	const projectPaths = $derived(new Set(projects.map((p) => p.path)));

	// Status dot, mirroring the home list: orange = running, red = error, neutral
	// for idle, a hollow ring for dead (so it survives e-ink without colour).
	function dotClass(s: DeckSession) {
		if (s.status === 'running') return 'bg-primary';
		if (s.status === 'error') return 'bg-error';
		if (s.status === 'dead') return 'border border-base-content/40';
		return 'bg-base-content/35';
	}

	// Two-level switcher across all sessions: project-group -> per-project subgroup
	// -> sessions, ordered per the rules in $lib/groups (issue #34).
	const groups = $derived(groupSessions(sessions, projects));

	// Collapse state, default-collapsed and persisted independently from the
	// homepage's (no auto-expand of the active session's group).
	const collapse = createCollapseState('deck:sidebar:expandedGroups');
</script>

<div class="flex items-center gap-2 px-2 pb-2">
	<FolderGit2 size={15} class="opacity-60" />
	<span class="text-sm font-semibold">Sessions</span>
</div>

<nav class="space-y-2">
	{#each groups as group (group.name)}
		{@const isOpen = collapse.has(group.name)}
		<div>
			<button
				class="flex w-full items-center gap-1 rounded-btn px-1 py-0.5 text-left hover:bg-base-200"
				onclick={() => collapse.toggle(group.name)}
				aria-expanded={isOpen}
			>
				{#if isOpen}
					<ChevronDown size={13} class="shrink-0 opacity-60" />
				{:else}
					<ChevronRight size={13} class="shrink-0 opacity-60" />
				{/if}
				<span class="min-w-0 flex-1 truncate text-xs font-semibold opacity-70">{group.name}</span>
				<span class="shrink-0 text-xs opacity-50">{group.sessionCount}</span>
			</button>
			{#if isOpen}
				<div class="mt-1 space-y-3 pl-3">
					{#each group.subgroups as g (g.key)}
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
										<Plus size={14} class="text-primary" />
									</button>
								{/if}
							</div>
							<ul class="mt-0.5 space-y-0.5">
								{#each g.sessions as s (s.id)}
									<li class="flex items-center gap-1 px-1">
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
											{#if serverDot(s.id)}
												{@const st = serverDot(s.id)!}
												<span class="size-1.5 shrink-0 rounded-full {SERVER_DOT[st]}" title={`servers: ${SERVER_LABEL[st]}`}></span>
											{/if}
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
				</div>
			{/if}
		</div>
	{/each}

	{#if groups.length === 0}
		<p class="px-2 py-1 text-xs opacity-50">No sessions yet.</p>
	{/if}
</nav>
