<script lang="ts">
	import type { RunDigest } from '$lib/workflows';
	import { api, allowedControls, pollWhileVisible, RUN_STATUS_VIEW, type RunControl } from '$lib/workflow-view';
	import { ISSUE_BADGE, shortIssueId } from '$lib/issues';
	import { relativeTime } from '$lib/time';
	import { page } from '$app/state';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import { ArrowLeft, GitBranch, GitPullRequest, CircleHelp, Pause, Hand, Play, RotateCcw, Ban } from '@lucide/svelte';

	type RunView = RunDigest & { handoffStale?: boolean };

	const id = $derived(page.params.id ?? '');
	let run = $state<RunView | null>(null);
	let loadError = $state('');
	let actionError = $state('');
	let busy = $state<string | null>(null);
	let answerText = $state('');
	let handoffText = $state('');
	let resumeAt = $state('');

	const controls = $derived(run ? allowedControls(run.status) : new Set<RunControl>());
	const escalations = $derived(run ? Object.entries(run.escalations).filter(([, spent]) => spent).map(([k]) => k) : []);
	const prUrl = $derived(run?.pr ? (run.pr.url ?? `https://github.com/${run.pr.repo}/pull/${run.pr.number}`) : '');

	async function load() {
		try {
			run = await api<RunView>(`/api/agent/runs/${encodeURIComponent(id)}`);
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'failed to load the run';
		}
	}

	$effect(() => {
		id;
		return pollWhileVisible(load, 3000);
	});

	async function act(action: string, body: Record<string, unknown> = {}): Promise<boolean> {
		busy = action;
		actionError = '';
		try {
			await api(`/api/agent/runs/${encodeURIComponent(id)}/${action}`, 'POST', body);
			await load();
			return true;
		} catch (e) {
			actionError = e instanceof Error ? e.message : `${action} failed`;
			return false;
		} finally {
			busy = null;
		}
	}

	async function answer() {
		if (await act('answer', { text: answerText.trim() })) answerText = '';
	}

	// Resuming a running run stops its live agent, so it asks first, like Cancel.
	async function resume() {
		const live = run?.status === 'running' || (run?.status === 'paused' && !run.humanTouched);
		if (live && !confirm('This stops the phase session if it is still working, then resumes. Continue?')) return;
		if (await act('resume', resumeAt ? { phase: resumeAt } : {})) resumeAt = '';
	}

	async function saveHandoff() {
		if (await act('handoff', { text: handoffText.trim() })) handoffText = '';
	}

	function cancel() {
		if (confirm('Cancel this run? Its phase session is stopped and the run will not move again.')) act('cancel');
	}
</script>

<svelte:head><title>{run?.title ?? 'Run'} · deck</title></svelte:head>

<div class="mb-4 flex items-center gap-2">
	<a href="/runs" class="btn btn-ghost btn-sm" aria-label="Back to runs"><ArrowLeft size={16} /></a>
	<h1 class="min-w-0 flex-1 truncate text-lg font-semibold">{run?.title ?? 'Run'}</h1>
	{#if run}
		<span class="badge {RUN_STATUS_VIEW[run.status].badge}">{RUN_STATUS_VIEW[run.status].label}</span>
	{/if}
</div>

{#if loadError}
	<div class="alert alert-error mb-3 py-2 text-sm">{loadError}</div>
{/if}

{#if !run}
	{#if !loadError}<p class="p-8 text-center opacity-60">Loading...</p>{/if}
{:else}
	<div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
		<span class="opacity-70">{run.workflow.name}</span>
		<span class="inline-flex items-center gap-1 font-mono opacity-70"><GitBranch size={12} />{run.branch}</span>
		{#if run.issue}
			<a class="link link-hover inline-flex items-center gap-1" href={run.issue.url} target="_blank" rel="noreferrer" title={run.issue.id}>
				<span class="badge badge-xs {ISSUE_BADGE[run.issue.source].cls}">{ISSUE_BADGE[run.issue.source].label}</span>
				{shortIssueId(run.issue.source, run.issue.id)}
			</a>
		{/if}
		{#if run.pr}
			<a class="link link-hover inline-flex items-center gap-1" href={prUrl} target="_blank" rel="noreferrer">
				<GitPullRequest size={12} />{run.pr.repo}#{run.pr.number}
			</a>
		{/if}
		{#if run.cap}
			<span class="opacity-70">round <span class="font-mono">{run.round}/{run.cap}</span></span>
		{/if}
		<span class="opacity-70" title="Escalations spent: {escalations.join(', ') || 'none'}">
			escalations <span class="font-mono">{escalations.length}/{Object.keys(run.escalations).length}</span>
		</span>
		<span class="opacity-50">updated {relativeTime(run.updatedAt)}</span>
	</div>

	{#if run.error}
		<div class="alert alert-error mb-3 py-2 text-sm" role="alert">{run.error}</div>
	{/if}
	{#if actionError}
		<div class="alert alert-error mb-3 py-2 text-sm" role="alert">{actionError}</div>
	{/if}

	{#if run.status === 'blocked' && run.block}
		<section class="mb-4 rounded-box border-2 border-warning bg-base-100 p-4" aria-live="polite">
			<div class="mb-1 flex items-center gap-2 text-xs opacity-70">
				<CircleHelp size={14} class="text-warning" />
				<span>Blocked at {run.block.step}, asked by {run.block.by} {relativeTime(run.block.at)} ago</span>
			</div>
			<p class="text-sm font-medium whitespace-pre-wrap">{run.block.question}</p>
			<textarea class="textarea textarea-sm mt-3 w-full" rows="3" placeholder="Your answer" aria-label="Your answer" bind:value={answerText}></textarea>
			<div class="mt-2 flex justify-end">
				<button class="btn btn-sm btn-primary" onclick={answer} disabled={!answerText.trim() || !!busy}>Answer and resume</button>
			</div>
		</section>
	{/if}

	<section class="mb-4">
		<WorkflowGraph phases={run.phases} current={run.phase} />
	</section>

	<div class="grid gap-4 lg:grid-cols-2">
		<section class="rounded-box border border-base-300 bg-base-100 p-4">
			<h2 class="mb-3 text-sm font-semibold">Controls</h2>
			<div class="flex flex-wrap gap-2">
				<button class="btn btn-sm" onclick={() => act('pause')} disabled={!controls.has('pause') || !!busy}>
					<Pause size={14} /> Pause
				</button>
				<button class="btn btn-sm" onclick={() => act('takeover')} disabled={!controls.has('takeover') || !!busy}>
					<Hand size={14} /> Take over
				</button>
				<button class="btn btn-sm" onclick={() => act('retry')} disabled={!controls.has('retry') || !!busy}>
					<RotateCcw size={14} /> Retry
				</button>
				<button class="btn btn-sm btn-ghost text-error" onclick={cancel} disabled={!controls.has('cancel') || !!busy}>
					<Ban size={14} /> Cancel
				</button>
			</div>
			<p class="mt-2 text-xs opacity-60">Take over pauses the run and stops the phase session so you can drive it yourself.</p>
			<div class="join mt-3">
				<select class="select select-sm join-item" bind:value={resumeAt} disabled={!controls.has('resume')} aria-label="Resume at phase">
					<option value="">{run.phase} (current)</option>
					{#each run.phases.filter((p) => p.id !== run?.phase) as p (p.id)}
						<option value={p.id}>{p.id}</option>
					{/each}
				</select>
				<button
					class="btn btn-sm join-item"
					onclick={resume}
					disabled={!controls.has('resume') || !!busy}
				>
					<Play size={14} /> Resume
				</button>
			</div>
		</section>

		<section class="rounded-box border border-base-300 bg-base-100 p-4">
			<div class="mb-2 flex items-center gap-2">
				<h2 class="text-sm font-semibold">Handoff</h2>
				{#if run.handoff && run.handoffStale}
					<span class="badge badge-xs badge-warning" title="The working tree changed since this note was written">stale</span>
				{/if}
				{#if run.handoff}<span class="ml-auto text-xs opacity-50">{relativeTime(run.handoff.at)}</span>{/if}
			</div>
			{#if run.handoff}
				<p class="mb-3 text-sm whitespace-pre-wrap {run.handoffStale ? 'opacity-60' : ''}">{run.handoff.text}</p>
			{:else}
				<p class="mb-3 text-xs opacity-50">No handoff note. Leave one when you hand a phase back so the next session knows your intent.</p>
			{/if}
			<textarea class="textarea textarea-sm w-full" rows="3" placeholder="What you changed and why" aria-label="Handoff note" bind:value={handoffText}></textarea>
			<div class="mt-2 flex justify-end">
				<button class="btn btn-sm" onclick={saveHandoff} disabled={!handoffText.trim() || !!busy}>Save handoff</button>
			</div>
		</section>
	</div>

	{#if run.findings.length}
		<section class="mt-4 rounded-box border border-base-300 bg-base-100 p-4">
			<h2 class="mb-2 text-sm font-semibold">Findings <span class="font-normal opacity-60">this round</span></h2>
			<ul class="space-y-1.5">
				{#each run.findings as f, i (i)}
					<li class="flex flex-wrap items-baseline gap-2 text-sm">
						<span class="badge badge-xs {f.severity.toLowerCase() === 'blocker' ? 'badge-error' : 'badge-ghost'}">{f.severity}</span>
						<span class="font-mono text-xs opacity-80">{f.file}{f.line ? `:${f.line}` : ''}</span>
						<span class="min-w-0 basis-full sm:basis-auto sm:flex-1">{f.defect}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/if}
