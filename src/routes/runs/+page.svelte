<script lang="ts">
	import type { RunDigest, WorkflowDef } from '$lib/workflows';
	import {
		api,
		basename,
		defaultWorkflow,
		parseIssueRef,
		parsePrRef,
		pollWhileVisible,
		workflowsByCategory,
		PHASE_STATUS_VIEW,
		RUN_STATUS_VIEW
	} from '$lib/workflow-view';
	import { relativeTime } from '$lib/time';
	import { goto } from '$app/navigation';
	import { ArrowLeft, Plus, X, Eye, ExternalLink, CircleHelp, GitBranch, Trash2 } from '@lucide/svelte';

	interface AgentProject {
		path: string;
		name: string;
		hidden?: boolean;
	}

	let runs = $state<RunDigest[]>([]);
	let loaded = $state(false);
	let loadError = $state('');
	let workflows = $state<WorkflowDef[]>([]);
	let problems = $state<string[]>([]);
	let projects = $state<AgentProject[]>([]);
	let overseer = $state<{ sessionId?: string; active: boolean; busy: boolean } | null>(null);
	let overseerBusy = $state(false);

	let formOpen = $state(false);
	let cwd = $state('');
	let workflowId = $state('');
	let ref = $state('');
	let base = $state('');
	let starting = $state(false);
	let formError = $state('');

	let clearing = $state(false);
	const finishedCount = $derived(runs.filter((r) => r.status === 'done' || r.status === 'cancelled').length);

	const groups = $derived(workflowsByCategory(workflows));
	const workflow = $derived(workflows.find((w) => w.id === workflowId));
	const isReview = $derived(workflow?.category === 'review');

	async function load() {
		try {
			[runs, overseer] = await Promise.all([
				api<RunDigest[]>('/api/agent/runs'),
				api<{ sessionId?: string; active: boolean; busy: boolean }>('/api/agent/overseer')
			]);
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'failed to load runs';
		}
		if (!loaded) formOpen = runs.length === 0;
		loaded = true;
	}

	async function loadSetup() {
		const [defs, list] = await Promise.all([
			api<{ workflows: WorkflowDef[]; problems: string[] }>('/api/agent/workflows'),
			api<AgentProject[]>('/api/agent/projects')
		]).catch((e): [{ workflows: WorkflowDef[]; problems: string[] }, AgentProject[]] => {
			loadError = e instanceof Error ? e.message : 'failed to load workflows';
			return [{ workflows: [], problems: [] }, []];
		});
		workflows = defs.workflows;
		problems = defs.problems;
		projects = list.filter((p) => !p.hidden);
		workflowId ||= defaultWorkflow(workflows)?.id ?? '';
		cwd ||= projects[0]?.path ?? '';
	}

	$effect(() => pollWhileVisible(load, 3000));
	$effect(() => {
		loadSetup();
	});

	function reference(): Record<string, unknown> | string {
		const text = ref.trim();
		if (!text) return {};
		if (isReview) {
			const pr = parsePrRef(text);
			return pr ? { pr } : 'Use a PR URL or owner/repo#123.';
		}
		const issue = parseIssueRef(text);
		return issue ? { issue } : 'Use owner/repo#123, a GitHub issue URL, or a Linear id like ABC-123.';
	}

	async function start(e: SubmitEvent) {
		e.preventDefault();
		formError = '';
		const picked = reference();
		if (typeof picked === 'string') {
			formError = picked;
			return;
		}
		starting = true;
		try {
			const run = await api<RunDigest>('/api/agent/runs', 'POST', {
				cwd,
				workflow: workflowId || undefined,
				category: workflow?.category,
				base: base.trim() || undefined,
				...picked
			});
			await goto(`/runs/${encodeURIComponent(run.id)}`);
		} catch (err) {
			formError = err instanceof Error ? err.message : 'failed to start the run';
		} finally {
			starting = false;
		}
	}

	async function clearFinished() {
		const n = finishedCount;
		if (!confirm(`Delete ${n} finished run${n === 1 ? '' : 's'}? Their phase sessions and worktrees are kept.`)) return;
		clearing = true;
		try {
			await api('/api/agent/runs?finished=1', 'DELETE');
			await load();
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'clearing finished runs failed';
		} finally {
			clearing = false;
		}
	}

	async function toggleOverseer() {
		overseerBusy = true;
		try {
			overseer = await api('/api/agent/overseer', overseer?.active ? 'DELETE' : 'POST', overseer?.active ? undefined : {});
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'overseer request failed';
		} finally {
			overseerBusy = false;
		}
	}

	function currentLabel(run: RunDigest): string {
		const phase = run.phases.find((p) => p.id === run.phase);
		return phase?.label ?? run.phase;
	}
</script>

<svelte:head><title>Runs · deck</title></svelte:head>

<div class="mb-4 flex items-center gap-2">
	<a href="/" class="btn btn-ghost btn-sm" aria-label="Back"><ArrowLeft size={16} /></a>
	<h1 class="text-lg font-semibold">Runs</h1>
	<div class="flex-1"></div>
	{#if finishedCount > 0}
		<button class="btn btn-sm btn-ghost" onclick={clearFinished} disabled={clearing}>
			<Trash2 size={16} /> Clear finished ({finishedCount})
		</button>
	{/if}
	<button class="btn btn-sm {formOpen ? 'btn-ghost' : 'btn-primary'}" onclick={() => (formOpen = !formOpen)}>
		{#if formOpen}<X size={16} /> Close{:else}<Plus size={16} /> Start run{/if}
	</button>
</div>

{#if loadError}
	<div class="alert alert-error mb-3 py-2 text-sm">{loadError}</div>
{/if}

<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
	<div class="min-w-0 space-y-4">
		{#if formOpen}
			<form class="rounded-box border border-base-300 bg-base-100 p-4" onsubmit={start}>
				<h2 class="mb-3 text-sm font-semibold">Start a run</h2>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="flex flex-col gap-1 text-xs">
						<span class="opacity-70">Project</span>
						<select class="select select-sm w-full" bind:value={cwd} required>
							{#each projects as p (p.path)}
								<option value={p.path}>{p.name}</option>
							{/each}
						</select>
					</label>
					<label class="flex flex-col gap-1 text-xs">
						<span class="opacity-70">Workflow</span>
						<select class="select select-sm w-full" bind:value={workflowId} required>
							{#each groups as g (g.category)}
								<optgroup label={g.category}>
									{#each g.workflows as w (w.id)}
										<option value={w.id}>{w.name}{w.default ? ' (default)' : ''}</option>
									{/each}
								</optgroup>
							{/each}
						</select>
					</label>
					<label class="flex flex-col gap-1 text-xs">
						<span class="opacity-70">{isReview ? 'Pull request' : 'Issue'}</span>
						<input
							class="input input-sm w-full font-mono"
							bind:value={ref}
							placeholder={isReview ? 'https://github.com/acme/web/pull/42' : 'acme/web#123 or ABC-123'}
							required
						/>
					</label>
					<label class="flex flex-col gap-1 text-xs">
						<span class="opacity-70">Base branch (optional)</span>
						<input class="input input-sm w-full font-mono" bind:value={base} placeholder="main" />
					</label>
				</div>
				{#if problems.length}
					<ul class="mt-3 space-y-0.5 text-xs text-warning">
						{#each problems as p (p)}<li>{p}</li>{/each}
					</ul>
				{/if}
				{#if formError}
					<div class="alert alert-error mt-3 py-2 text-sm">{formError}</div>
				{/if}
				<div class="mt-3 flex justify-end">
					<button class="btn btn-sm btn-primary" type="submit" disabled={starting || !cwd || !workflowId}>
						{starting ? 'Starting...' : 'Start'}
					</button>
				</div>
			</form>
		{/if}

		{#if !loaded}
			<p class="p-8 text-center opacity-60">Loading...</p>
		{:else if runs.length === 0}
			<p class="p-8 text-center text-sm opacity-60">No runs yet. Start one to walk an issue or a PR through its workflow.</p>
		{:else}
			<ul class="space-y-2">
				{#each runs as run (run.id)}
					{@const view = RUN_STATUS_VIEW[run.status]}
					{@const muted = run.status === 'paused' || run.status === 'cancelled'}
					<li>
						<a
							href="/runs/{encodeURIComponent(run.id)}"
							class="block rounded-box border border-l-[3px] border-base-300 bg-base-100 px-3 py-2 hover:bg-base-200 {view.accent}"
						>
							<div class="flex items-center gap-2">
								<span class="min-w-0 flex-1 truncate text-sm font-medium {muted ? 'opacity-60' : ''}">{run.title}</span>
								<span class="badge badge-sm {view.badge}">{view.label}</span>
								<span class="w-8 text-right text-xs opacity-50">{relativeTime(run.updatedAt)}</span>
							</div>
							<div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs opacity-60">
								<span class="truncate">{run.workflow.name}</span>
								<span aria-hidden="true">·</span>
								<span class="truncate">{basename(run.projectPath)}</span>
								<span aria-hidden="true">·</span>
								<GitBranch size={11} class="shrink-0" />
								<span class="truncate font-mono">{run.branch}</span>
							</div>
							<div class="mt-2 flex items-center gap-2">
								<div class="flex flex-1 gap-0.5" role="img" aria-label="Phases: {run.phases.map((p) => `${p.label} ${PHASE_STATUS_VIEW[p.status].label}`).join(', ')}">
									{#each run.phases as p (p.id)}
										<span
											class="h-1.5 flex-1 rounded-sm {PHASE_STATUS_VIEW[p.status].fill} {p.id === run.phase ? 'outline outline-1 outline-offset-1 outline-base-content/40' : ''}"
											title="{p.label}: {PHASE_STATUS_VIEW[p.status].label}"
										></span>
									{/each}
								</div>
								<span class="shrink-0 text-xs opacity-70">
									{currentLabel(run)}{#if run.cap}<span class="ml-1.5 opacity-70">round <span class="font-mono">{run.round}/{run.cap}</span></span>{/if}
								</span>
							</div>
							{#if run.status === 'blocked' && run.block}
								<p class="mt-2 flex items-start gap-1.5 text-sm">
									<CircleHelp size={14} class="mt-0.5 shrink-0 text-warning" />
									<span class="line-clamp-2">{run.block.question}</span>
								</p>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<aside class="h-fit rounded-box border border-base-300 bg-base-100 p-4">
		<div class="flex items-center gap-2">
			<Eye size={15} class="opacity-60" />
			<h2 class="text-sm font-semibold">Overseer</h2>
			<span class="badge badge-sm ml-auto {overseer?.active ? 'badge-secondary' : 'badge-ghost'}">
				{overseer?.active ? 'watching' : 'off'}
			</span>
		</div>
		<p class="mt-2 text-xs opacity-60">
			A session that watches every run, steers stuck phases, and blocks on a question when it needs you.
		</p>
		<div class="mt-3 flex items-center gap-2">
			<button class="btn btn-sm {overseer?.active ? 'btn-ghost' : 'btn-secondary'}" onclick={toggleOverseer} disabled={overseerBusy || !overseer}>
				{overseer?.active ? 'Stop watching' : 'Start overseer'}
			</button>
			{#if overseer?.sessionId}
				<a class="link link-hover ml-auto inline-flex items-center gap-1 text-xs" href="/s/{encodeURIComponent(overseer.sessionId)}">
					Open session <ExternalLink size={11} />
				</a>
			{/if}
		</div>
	</aside>
</div>
