<script lang="ts">
	// The scheduler's page (issue #235): the schedules, and the form to add or
	// edit one. A schedule either sends its prompt into a session that already
	// exists or spawns a fresh one in a directory, and that choice is the first
	// thing the form asks, because everything below it depends on the answer.
	import type { ScheduleDigest } from '$lib/schedules';
	import { OUTCOME_VIEW } from '$lib/schedules';
	import type { DeckSession, DeckSettings, Project } from '$lib/types';
	import { api, pollWhileVisible } from '$lib/workflow-view';
	import { CRON_PRESETS, cronProblem, nextRuns } from '$lib/cron';
	import { clockTime, relativeTime, shortPath, whenDue } from '$lib/time';
	import { toRow, fromRow, type AgentRow } from '$lib/automation-form-core';
	import { loadSettings } from '$lib/settings-store';
	import { page } from '$app/state';
	import AutomationAgentForm from '$lib/components/AutomationAgentForm.svelte';
	import { ArrowLeft, Clock, ExternalLink, Pencil, Play, Plus, Trash2, X } from '@lucide/svelte';

	let schedules = $state<ScheduleDigest[]>([]);
	let projects = $state<Project[]>([]);
	let sessions = $state<DeckSession[]>([]);
	let settings = $state<DeckSettings>({});
	let loaded = $state(false);
	let loadError = $state('');

	// The form. `editing` holds the id being changed, so the same fields serve
	// adding and editing rather than there being two of everything.
	let formOpen = $state(false);
	let editing = $state<string | null>(null);
	let mode = $state<'spawn' | 'ongoing'>('spawn');
	let title = $state('');
	let cron = $state('0 9 * * *');
	let prompt = $state('');
	let cwd = $state('');
	let sessionId = $state('');
	let agent = $state<AgentRow>(toRow(undefined));
	let saving = $state(false);
	let formError = $state('');
	// Which row's buttons are mid-request, so only that row's spinner shows.
	let busyId = $state('');

	const problem = $derived(cronProblem(cron));
	// Recomputed off `schedules` as well as `cron`, so the preview stays live
	// while the page polls rather than freezing at the time the form opened.
	const preview = $derived(nextRuns(cron, Date.now(), 3));

	async function load() {
		try {
			schedules = await api<ScheduleDigest[]>('/api/agent/schedules');
			loadError = '';
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'failed to load schedules';
		}
		loaded = true;
	}

	async function loadSetup() {
		const [list, live, loadedSettings] = await Promise.all([
			api<Project[]>('/api/projects').catch(() => [] as Project[]),
			api<DeckSession[]>('/api/sessions').catch(() => [] as DeckSession[]),
			loadSettings().catch(() => ({}) as DeckSettings)
		]);
		projects = list.filter((p) => !p.hidden);
		// Only sessions that can take a prompt: a terminal has nothing to send to.
		sessions = live.filter((s) => s.kind !== 'shell' && s.status !== 'dead');
		settings = loadedSettings;
		cwd ||= projects[0]?.path ?? '';
	}

	$effect(() => pollWhileVisible(load, 5000));
	$effect(() => {
		loadSetup();
	});

	// Opened from a session's menu with ?session=<id>, which is how an existing
	// session is extended into a schedule. Runs once, so a later poll can't drag
	// the form back open after it has been used or closed.
	let deepLinked = false;
	$effect(() => {
		const id = page.url.searchParams.get('session');
		if (!id || deepLinked) return;
		deepLinked = true;
		startAdd();
		mode = 'ongoing';
		sessionId = id;
	});

	function startAdd() {
		editing = null;
		mode = 'spawn';
		title = '';
		cron = '0 9 * * *';
		prompt = '';
		sessionId = '';
		cwd = projects[0]?.path ?? '';
		agent = toRow(undefined);
		formError = '';
		formOpen = true;
	}

	function startEdit(schedule: ScheduleDigest) {
		editing = schedule.id;
		mode = schedule.sessionId ? 'ongoing' : 'spawn';
		title = schedule.title;
		cron = schedule.cron;
		prompt = schedule.prompt;
		sessionId = schedule.sessionId ?? '';
		cwd = schedule.cwd ?? projects[0]?.path ?? '';
		agent = toRow(schedule.agent);
		formError = '';
		formOpen = true;
	}

	function closeForm() {
		formOpen = false;
		editing = null;
		formError = '';
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		formError = '';
		saving = true;
		// Only ever one target: send the half this mode means and a blank for the
		// other, so switching an existing schedule from one shape to the other
		// clears what it used to point at.
		const target = mode === 'ongoing' ? { sessionId, cwd: '' } : { cwd, sessionId: '' };
		try {
			const body = { title: title.trim(), cron, prompt, agent: fromRow(agent), ...target };
			if (editing) await api(`/api/agent/schedules/${encodeURIComponent(editing)}`, 'PATCH', body);
			else await api('/api/agent/schedules', 'POST', body);
			closeForm();
			await load();
		} catch (err) {
			formError = err instanceof Error ? err.message : 'failed to save the schedule';
		} finally {
			saving = false;
		}
	}

	async function act(id: string, run: () => Promise<unknown>) {
		busyId = id;
		loadError = '';
		try {
			await run();
			await load();
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'the request failed';
		} finally {
			busyId = '';
		}
	}

	function toggle(schedule: ScheduleDigest) {
		const url = `/api/agent/schedules/${encodeURIComponent(schedule.id)}`;
		return act(schedule.id, () => api(url, 'PATCH', { enabled: !schedule.enabled }));
	}

	function runNow(schedule: ScheduleDigest) {
		const url = `/api/agent/schedules/${encodeURIComponent(schedule.id)}/run`;
		return act(schedule.id, () => api(url, 'POST', {}));
	}

	function remove(schedule: ScheduleDigest) {
		if (!confirm(`Delete "${schedule.title}"? The sessions it has already started are kept.`)) return;
		const url = `/api/agent/schedules/${encodeURIComponent(schedule.id)}`;
		return act(schedule.id, () => api(url, 'DELETE'));
	}

	// What a schedule points at, in a few words. A session target that has gone
	// says so: it is the reason the schedule stopped.
	function target(schedule: ScheduleDigest): string {
		if (schedule.sessionId) return schedule.sessionTitle ?? 'session no longer exists';
		return schedule.projectName ?? shortPath(schedule.cwd ?? '');
	}
</script>

<svelte:head><title>Schedules · deck</title></svelte:head>

<div class="mb-4 flex items-center gap-2">
	<a href="/" class="btn btn-ghost btn-sm" aria-label="Back"><ArrowLeft size={16} /></a>
	<h1 class="text-lg font-semibold">Schedules</h1>
	<div class="flex-1"></div>
	<button class="btn btn-sm {formOpen ? 'btn-ghost' : 'btn-primary'}" onclick={() => (formOpen ? closeForm() : startAdd())}>
		{#if formOpen}<X size={16} /> Close{:else}<Plus size={16} /> New schedule{/if}
	</button>
</div>

{#if loadError}
	<div class="alert alert-error mb-3 py-2 text-sm">{loadError}</div>
{/if}

<div class="space-y-4">
	{#if formOpen}
		<form class="rounded-box border border-base-300 bg-base-100 p-4" onsubmit={save}>
			<h2 class="mb-3 text-sm font-semibold">{editing ? 'Edit schedule' : 'New schedule'}</h2>

			<!-- The choice everything else depends on, so it comes first. -->
			<div class="mb-3 flex flex-col gap-1 text-xs">
				<span class="opacity-70">Each run</span>
				<div class="join">
					<button
						type="button"
						class="btn join-item btn-sm {mode === 'spawn' ? 'btn-active' : ''}"
						onclick={() => (mode = 'spawn')}
					>
						Starts a new session
					</button>
					<button
						type="button"
						class="btn join-item btn-sm {mode === 'ongoing' ? 'btn-active' : ''}"
						onclick={() => (mode = 'ongoing')}
					>
						Sends to one session
					</button>
				</div>
				<span class="opacity-60">
					{mode === 'spawn'
						? 'A fresh session each time, so every run looks at the project as it stands.'
						: 'The same session every time, so what it worked out last run is still there.'}
				</span>
			</div>

			<div class="grid gap-3 sm:grid-cols-2">
				{#if mode === 'ongoing'}
					<label class="flex flex-col gap-1 text-xs">
						<span class="opacity-70">Session</span>
						<select class="select select-sm w-full" bind:value={sessionId} required>
							<option value="" disabled>Pick a session</option>
							{#each sessions as s (s.id)}
								<option value={s.id}>{s.title}</option>
							{/each}
						</select>
					</label>
				{:else}
					<label class="flex flex-col gap-1 text-xs">
						<span class="opacity-70">Project</span>
						<select class="select select-sm w-full" bind:value={cwd} required>
							{#each projects as p (p.path)}
								<option value={p.path}>{p.name}</option>
							{/each}
						</select>
					</label>
				{/if}
				<label class="flex flex-col gap-1 text-xs">
					<span class="opacity-70">Name (optional)</span>
					<input class="input input-sm w-full" bind:value={title} placeholder="Taken from the prompt" />
				</label>
			</div>

			<div class="mt-3 grid gap-3 sm:grid-cols-2">
				<label class="flex flex-col gap-1 text-xs">
					<span class="opacity-70">Repeat</span>
					<select class="select select-sm w-full" value={cron} onchange={(e) => (cron = e.currentTarget.value)}>
						{#each CRON_PRESETS as p (p.cron)}
							<option value={p.cron}>{p.label}</option>
						{/each}
						{#if !CRON_PRESETS.some((p) => p.cron === cron)}
							<option value={cron}>Custom</option>
						{/if}
					</select>
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="opacity-70">Or a cron expression</span>
					<input class="input input-sm w-full font-mono" bind:value={cron} placeholder="0 9 * * mon-fri" required />
				</label>
			</div>

			<!-- The preview, rather than a sentence describing the expression: it
				is the schedule's own answer to what it means, and it cannot be
				wrong about it. -->
			<p class="mt-1.5 text-xs">
				{#if problem}
					<span class="text-error">{problem}</span>
				{:else if preview.length}
					<span class="opacity-60">Next:</span>
					<span class="font-mono">{preview.map((ts) => whenDue(ts)).join(', ')}</span>
				{:else}
					<span class="text-warning">That expression has no next run.</span>
				{/if}
			</p>

			<label class="mt-3 flex flex-col gap-1 text-xs">
				<span class="opacity-70">Prompt</span>
				<textarea
					class="textarea textarea-sm min-h-24 w-full"
					bind:value={prompt}
					placeholder="Check which dependencies have advisories and open an issue for anything that needs a decision."
					required
				></textarea>
			</label>

			{#if mode === 'spawn'}
				<div class="mt-3">
					<AutomationAgentForm bind:agent {settings} lane="schedule" />
				</div>
			{/if}

			{#if formError}
				<div class="alert alert-error mt-3 py-2 text-sm">{formError}</div>
			{/if}
			<div class="mt-3 flex justify-end gap-2">
				<button class="btn btn-sm btn-ghost" type="button" onclick={closeForm}>Cancel</button>
				<button class="btn btn-sm btn-primary" type="submit" disabled={saving || !!problem || !prompt.trim()}>
					{saving ? 'Saving...' : editing ? 'Save' : 'Add schedule'}
				</button>
			</div>
		</form>
	{/if}

	{#if !loaded}
		<p class="p-8 text-center opacity-60">Loading...</p>
	{:else if schedules.length === 0}
		<p class="p-8 text-center text-sm opacity-60">
			No schedules yet. Add one to run a prompt on a clock, in a fresh session each time or in one that keeps its context.
		</p>
	{:else}
		<ul class="space-y-2">
			{#each schedules as schedule (schedule.id)}
				{@const outcome = schedule.lastOutcome ? OUTCOME_VIEW[schedule.lastOutcome] : null}
				{@const broken = schedule.sessionId && !schedule.sessionTitle}
				<li
					class="rounded-box border border-l-[3px] border-base-300 bg-base-100 px-3 py-2 {schedule.enabled
						? broken
							? 'border-l-error'
							: 'border-l-primary'
						: 'border-l-base-300'}"
				>
					<div class="flex items-center gap-2">
						<span class="min-w-0 flex-1 truncate text-sm font-medium {schedule.enabled ? '' : 'opacity-60'}">
							{schedule.title}
						</span>
						{#if outcome}
							<span
								class="badge badge-sm {outcome.tone === 'bad'
									? 'badge-error'
									: outcome.tone === 'ok'
										? 'badge-success'
										: 'badge-ghost'}"
							>
								{outcome.label}
							</span>
						{/if}
						<input
							type="checkbox"
							class="toggle toggle-sm"
							checked={schedule.enabled}
							disabled={busyId === schedule.id}
							aria-label="{schedule.enabled ? 'Pause' : 'Resume'} {schedule.title}"
							onchange={() => toggle(schedule)}
						/>
					</div>

					<div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs opacity-60">
						<span class="font-mono">{schedule.cron}</span>
						<span aria-hidden="true">·</span>
						<span class="truncate {broken ? 'text-error' : ''}">{target(schedule)}</span>
						{#if schedule.enabled && schedule.nextRunAt}
							<span aria-hidden="true">·</span>
							<Clock size={11} class="shrink-0" />
							<span>next {whenDue(schedule.nextRunAt)}</span>
						{/if}
						{#if schedule.runs > 0}
							<span aria-hidden="true">·</span>
							<span>{schedule.runs} run{schedule.runs === 1 ? '' : 's'}</span>
						{/if}
					</div>

					<p class="mt-1.5 line-clamp-2 text-sm opacity-80">{schedule.prompt}</p>

					{#if schedule.lastNote}
						<p class="mt-1 text-xs {schedule.lastOutcome === 'failed' ? 'text-error' : 'opacity-60'}">
							Last run {schedule.lastRunAt ? relativeTime(schedule.lastRunAt) : ''} ago: {schedule.lastNote}
						</p>
					{:else if schedule.lastRunAt}
						<p class="mt-1 text-xs opacity-60">
							Last ran {relativeTime(schedule.lastRunAt)} ago at {clockTime(schedule.lastRunAt)}
						</p>
					{/if}

					<div class="mt-2 flex items-center gap-1">
						<button
							class="btn btn-ghost btn-xs"
							disabled={busyId === schedule.id}
							onclick={() => runNow(schedule)}
						>
							<Play size={12} /> Run now
						</button>
						<button class="btn btn-ghost btn-xs" onclick={() => startEdit(schedule)}>
							<Pencil size={12} /> Edit
						</button>
						{#if schedule.lastSessionId}
							<a class="btn btn-ghost btn-xs" href="/s/{encodeURIComponent(schedule.lastSessionId)}">
								Last session <ExternalLink size={11} />
							</a>
						{/if}
						<button
							class="btn btn-ghost btn-xs ml-auto text-error"
							disabled={busyId === schedule.id}
							onclick={() => remove(schedule)}
						>
							<Trash2 size={12} /> Delete
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
