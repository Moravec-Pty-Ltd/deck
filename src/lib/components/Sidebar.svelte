<script lang="ts">
	import { browser } from '$app/environment';
	import type { DeckSession, Project, ServerState } from '$lib/types';
	import { groupSessions } from '$lib/groups';
	import { bucketSessions, type StatusBucketKey } from '$lib/status-groups';
	import { createCollapseState } from '$lib/collapse.svelte';
	import { aggregateState, SERVER_DOT, SERVER_LABEL } from '$lib/servers';
	import { PR_STATE_COLOR } from '$lib/pr';
	import { Plus, Terminal, Bot, GitBranch, FolderGit2, FolderTree, Activity, Trash2, ChevronRight, ChevronDown } from '@lucide/svelte';

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

	// The same dot vocabulary keyed by status bucket, for the "By status" headers;
	// Needs attention takes the error colour so it stands out (issue #48), and
	// Just finished takes success green to read as "done its turn" next to Idle grey.
	function bucketDot(key: StatusBucketKey) {
		if (key === 'needs-attention') return 'bg-error';
		if (key === 'active') return 'bg-primary';
		if (key === 'just-finished') return 'bg-success';
		if (key === 'dead') return 'border border-base-content/40';
		return 'bg-base-content/35';
	}

	// Grouping mode toggle (issue #48), persisted so the choice survives reloads;
	// default "By project" so nothing changes until you switch.
	const VIEW_KEY = 'deck:sidebar:viewMode';
	function loadView(): 'project' | 'status' {
		if (!browser) return 'project';
		return localStorage.getItem(VIEW_KEY) === 'status' ? 'status' : 'project';
	}
	let viewMode = $state<'project' | 'status'>(loadView());
	function toggleView() {
		viewMode = viewMode === 'project' ? 'status' : 'project';
		if (browser) {
			try {
				localStorage.setItem(VIEW_KEY, viewMode);
			} catch {
				// persistence is non-critical; keep the in-memory choice.
			}
		}
	}

	// Two-level switcher across all sessions: project-group -> per-project subgroup
	// -> sessions, ordered per the rules in $lib/groups (issue #34).
	const groups = $derived(groupSessions(sessions, projects));

	// Attention-first buckets cutting across projects, for the "By status" view.
	const buckets = $derived(bucketSessions(sessions));

	// Collapse state, default-collapsed and persisted independently from the
	// homepage's (no auto-expand of the active session's group).
	const collapse = createCollapseState('deck:sidebar:expandedGroups');

	// Status buckets default *expanded*, so this set tracks the collapsed ones
	// (the inverse of the project-view collapse) reusing the same #34 mechanism.
	const statusCollapse = createCollapseState('deck:sidebar:collapsedStatusBuckets');
</script>

{#snippet sessionRow(s: DeckSession)}
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
			<span class="size-1.5 shrink-0 rounded-full {dotClass(s)}" title={s.status}></span>
			<span class="min-w-0 flex-1 truncate text-sm">{s.title}</span>
			{#if serverDot(s.id)}
				{@const st = serverDot(s.id)!}
				<span class="size-1.5 shrink-0 rounded-full {SERVER_DOT[st]}" title={`servers: ${SERVER_LABEL[st]}`}></span>
			{/if}
			{#if s.worktree}
				{@const prColor = s.pr?.state ? PR_STATE_COLOR[s.pr.state] : undefined}
				<GitBranch
					size={11}
					class="shrink-0 {prColor ? '' : 'opacity-40'}"
					style={prColor ? `color:${prColor}` : undefined}
					title={prColor ? `PR ${s.pr?.state}` : undefined}
				/>
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
{/snippet}

<div class="flex items-center gap-2 px-2 pb-2">
	<FolderGit2 size={15} class="opacity-60" />
	<span class="text-sm font-semibold">Sessions</span>
	<button
		class="btn btn-ghost btn-xs ml-auto"
		onclick={toggleView}
		aria-label={viewMode === 'project' ? 'Group by status' : 'Group by project'}
		title={viewMode === 'project' ? 'Group by status' : 'Group by project'}
	>
		{#if viewMode === 'project'}
			<Activity size={14} class="opacity-70" />
		{:else}
			<FolderTree size={14} class="opacity-70" />
		{/if}
	</button>
</div>

<nav class="space-y-2">
	{#if viewMode === 'status'}
		{#each buckets as bucket (bucket.key)}
			{@const isOpen = !statusCollapse.has(bucket.key)}
			<div>
				<button
					class="flex w-full items-center gap-1 rounded-btn px-1 py-0.5 text-left hover:bg-base-200"
					onclick={() => statusCollapse.toggle(bucket.key)}
					aria-expanded={isOpen}
				>
					{#if isOpen}
						<ChevronDown size={13} class="shrink-0 opacity-60" />
					{:else}
						<ChevronRight size={13} class="shrink-0 opacity-60" />
					{/if}
					<span class="size-1.5 shrink-0 rounded-full {bucketDot(bucket.key)}" title={bucket.label}></span>
					<span
						class="min-w-0 flex-1 truncate text-xs font-semibold {bucket.key === 'needs-attention'
							? 'text-error'
							: 'opacity-70'}">{bucket.label}</span
					>
					<span class="shrink-0 text-xs opacity-50">{bucket.sessions.length}</span>
				</button>
				{#if isOpen}
					<ul class="mt-1 space-y-0.5 pl-3">
						{#each bucket.sessions as s (s.id)}
							{@render sessionRow(s)}
						{/each}
					</ul>
				{/if}
			</div>
		{/each}

		{#if buckets.length === 0}
			<p class="px-2 py-1 text-xs opacity-50">No sessions yet.</p>
		{/if}
	{:else}
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
										{@render sessionRow(s)}
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
	{/if}
</nav>
