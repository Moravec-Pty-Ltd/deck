<script lang="ts">
	import { isAgentKind } from '$lib/types';
	import type { Issue, NewSessionPreset, Project, PullRequest, SessionKind } from '$lib/types';
	import { groupProjects, existingGroupNames } from '$lib/groups';
	import { CLAUDE_MODELS } from '$lib/models';
	import { SESSION_PLACEHOLDERS, REVIEW_PLACEHOLDERS } from '$lib/placeholders';
	import { Bot, Terminal, Sparkles, Braces, Ticket, X, TriangleAlert } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import PathInput from './PathInput.svelte';
	import IssuePicker from './IssuePicker.svelte';
	import PrPicker from './PrPicker.svelte';

	const KIND_OPTIONS = [
		{ id: 'claude', label: 'Claude', icon: Bot },
		{ id: 'pi', label: 'pi', icon: Sparkles },
		{ id: 'codex', label: 'codex', icon: Braces },
		{ id: 'shell', label: 'Shell', icon: Terminal }
	] as const;

	let { open = $bindable(false), preset = null }: { open?: boolean; preset?: NewSessionPreset | null } =
		$props();

	type Worktree = { path: string; branch: string; isMain: boolean };
	type WorktreeMode = 'none' | 'existing' | 'new';

	// 'new' starts a fresh branch/worktree; 'review' seeds the session from an open
	// PR awaiting your review (worktree checked out to the PR head).
	type SessionMode = 'new' | 'review';
	let mode = $state<SessionMode>('new');
	let kind = $state<SessionKind>('claude');
	let projects = $state<Project[]>([]);
	let cwd = $state('');
	let customCwd = $state('');
	let title = $state('');
	let model = $state('');
	let provider = $state('');
	let yolo = $state(true);
	let worktreeMode = $state<WorktreeMode>('new');
	let worktreeModeDirty = $state(false);
	let branch = $state('');
	let branchDirty = $state(false);
	let newBranch = $state(true);
	let base = $state('');
	let baseDirty = $state(false);
	let branches = $state<string[]>([]);
	let existingWorktrees = $state<Worktree[]>([]);
	let existingWorktreeDir = $state('');
	let prompt = $state('');
	let promptDirty = $state(false);
	let command = $state('');
	let newProjectPath = $state('');
	let newProjectGroup = $state('');
	let newProjectTemplate = $state('');
	let busy = $state(false);
	let errorMsg = $state('');
	let showPicker = $state(false);
	let pickedIssues = $state<Issue[]>([]);
	let pickedPr = $state<PullRequest | null>(null);

	const issueKey = (i: Issue) => `${i.sourceId}:${i.id}`;
	// Mirror the server's ISSUE_CAP (POST /api/sessions) so the selection can't
	// grow past what actually gets persisted and fetched.
	const MAX_ISSUES = 10;

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) init();
		wasOpen = open;
	});

	function init() {
		promptDirty = false;
		branchDirty = false;
		baseDirty = false;
		errorMsg = '';
		showPicker = false;
		mode = 'new';
		pickedIssues = [];
		pickedPr = null;
		const p = preset;
		worktreeModeDirty = !!(p?.kind || p?.cwd);
		fetch('/api/projects')
			.then((r) => r.json())
			.then((list: Project[]) => {
				projects = list;
				if (p?.kind) kind = p.kind;
				if (p?.projectPath) cwd = p.projectPath;
				else if (p?.cwd) {
					cwd = '__custom';
					customCwd = p.cwd;
				} else if (!cwd && list.length) cwd = list[0].path;
				if (p?.cwd) worktreeMode = 'none';
				if (p?.title !== undefined) title = p.title;
			});
	}

	const effectiveCwd = $derived(cwd === '__custom' ? customCwd : cwd);
	const selectedProject = $derived(projects.find((p) => p.path === cwd));
	const projectGroups = $derived(groupProjects(projects));
	const groupSuggestions = $derived(existingGroupNames(projects));
	const finalCwd = $derived(worktreeMode === 'existing' ? existingWorktreeDir : effectiveCwd);
	const titleRequired = $derived(isAgentKind(kind));
	const projectHasSources = $derived(!!selectedProject?.sources?.length);
	const reviewMode = $derived(mode === 'review');

	function setSessionMode(m: SessionMode) {
		mode = m;
		// Keep the two flows from leaking picks into each other.
		if (m === 'review') {
			pickedIssues = [];
			showPicker = false;
		} else {
			pickedPr = null;
		}
	}

	// Toggle an issue in/out of the selection. The title becomes the picked refs
	// concatenated (branch-name-safe — no spaces, so it drives the branch as a
	// single ref does today) and the branch follows it. The picker stays open for
	// multi-select; the modal renders removable chips for what's picked.
	function pickIssue(issue: Issue) {
		const k = issueKey(issue);
		const has = pickedIssues.some((i) => issueKey(i) === k);
		if (!has && pickedIssues.length >= MAX_ISSUES) {
			errorMsg = `attach at most ${MAX_ISSUES} issues`;
			return;
		}
		errorMsg = '';
		pickedIssues = has ? pickedIssues.filter((i) => issueKey(i) !== k) : [...pickedIssues, issue];
		title = pickedIssues.map((i) => i.id).join('+');
		branchDirty = false;
	}

	// Picking a PR names the session after it and remembers it so the worktree is
	// checked out to the PR head and the header chip lights up at creation.
	function pickPr(pr: PullRequest) {
		pickedPr = pr;
		title = pr.title;
	}

	// Drop any picked issue/PR when the project changes — a pick from one project
	// must not ride along into a session created under another.
	$effect(() => {
		cwd;
		pickedIssues = [];
		pickedPr = null;
	});

	// Worktree mode defaults to "new" for agents (branch off and work in isolation)
	// and "none" for shells (run right in the project), until the user overrides.
	$effect(() => {
		if (!worktreeModeDirty) worktreeMode = kind === 'shell' ? 'none' : 'new';
	});

	function setMode(m: WorktreeMode) {
		worktreeMode = m;
		worktreeModeDirty = true;
	}

	// Prefill the first prompt until the user edits it: the review prompt in Review
	// mode, the project template otherwise. Empty means an empty field, same as today.
	$effect(() => {
		const template =
			(mode === 'review' ? selectedProject?.reviewPrompt : selectedProject?.template) ?? '';
		if (!promptDirty) prompt = template;
	});

	// Branch defaults to the title until the user edits it.
	$effect(() => {
		if (worktreeMode === 'new' && !branchDirty) branch = title.trim();
	});

	// Base branch defaults to the project's remembered last base.
	$effect(() => {
		if (!baseDirty) base = selectedProject?.lastBase ?? '';
	});

	$effect(() => {
		if (worktreeMode === 'new' && effectiveCwd) {
			fetch(`/api/git/branches?repo=${encodeURIComponent(effectiveCwd)}`)
				.then((r) => r.json())
				.then((b: string[]) => (branches = Array.isArray(b) ? b : []));
		}
	});

	$effect(() => {
		if (worktreeMode === 'existing' && effectiveCwd) {
			fetch(`/api/git/worktrees?repo=${encodeURIComponent(effectiveCwd)}`)
				.then((r) => r.json())
				.then((w: Worktree[]) => {
					existingWorktrees = Array.isArray(w) ? w.filter((x) => !x.isMain) : [];
					if (!existingWorktrees.some((x) => x.path === existingWorktreeDir))
						existingWorktreeDir = existingWorktrees[0]?.path ?? '';
				});
		}
	});

	async function addProject() {
		if (!newProjectPath.trim()) return;
		const res = await fetch('/api/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				path: newProjectPath.trim(),
				group: newProjectGroup.trim() || undefined,
				template: newProjectTemplate.trim() || undefined
			})
		});
		if (res.ok) {
			const p: Project = await res.json();
			projects = [...projects.filter((x) => x.path !== p.path), p];
			cwd = p.path;
			promptDirty = false;
			newProjectPath = '';
			newProjectGroup = '';
			newProjectTemplate = '';
		} else {
			errorMsg = (await res.json()).message ?? 'failed to add project';
		}
	}

	async function create() {
		errorMsg = '';
		if (reviewMode && !pickedPr) {
			errorMsg = 'pick a PR to review';
			return;
		}
		if (titleRequired && !title.trim()) {
			errorMsg = 'title is required';
			return;
		}
		if (!reviewMode && worktreeMode === 'existing' && !existingWorktreeDir) {
			errorMsg = 'pick an existing worktree';
			return;
		}
		// Review mode always makes its own worktree from the project repo, so it
		// starts from the project path, not a picked existing-worktree dir.
		const startCwd = reviewMode ? effectiveCwd : finalCwd;
		if (!startCwd) {
			errorMsg = 'pick a project or path';
			return;
		}
		busy = true;
		try {
			const res = await fetch('/api/sessions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind,
					cwd: startCwd,
					title: title.trim() || undefined,
					model: model.trim() || undefined,
					provider: kind === 'pi' && provider.trim() ? provider.trim() : undefined,
					permissionMode:
						kind === 'claude' ? (yolo ? 'bypassPermissions' : 'acceptEdits') : undefined,
					command: kind === 'shell' && command.trim() ? command.trim() : undefined,
					prompt: kind !== 'shell' && prompt.trim() ? prompt.trim() : undefined,
					worktree:
						reviewMode && pickedPr
							? { fromPr: pickedPr.number, base: pickedPr.baseRefName }
							: worktreeMode === 'new' && branch.trim()
								? { branch: branch.trim(), newBranch, base: base || undefined }
								: undefined,
					issues:
						!reviewMode && pickedIssues.length
							? pickedIssues.map((i) => ({
									source: i.sourceType,
									sourceId: i.sourceId,
									id: i.id,
									url: i.url
								}))
							: undefined,
					pr:
						reviewMode && pickedPr
							? {
									repo: pickedPr.repo,
									number: pickedPr.number,
									url: pickedPr.url,
									title: pickedPr.title
								}
							: undefined
				})
			});
			const data = await res.json();
			if (!res.ok) {
				errorMsg = data.message ?? 'failed to create session';
				return;
			}
			open = false;
			prompt = '';
			title = '';
			branch = '';
			pickedIssues = [];
			pickedPr = null;
			goto(`/s/${encodeURIComponent(data.id)}`);
		} finally {
			busy = false;
		}
	}
</script>

{#if open}
	<div class="modal modal-open" role="dialog">
		<div class="modal-box max-w-lg overflow-x-hidden">
			<h3 class="mb-4 text-lg font-semibold">New session</h3>

			<div class="join mb-4 w-full">
				<button
					class="btn join-item flex-1 {mode === 'new' ? 'btn-primary' : ''}"
					onclick={() => setSessionMode('new')}>New</button
				>
				<button
					class="btn join-item flex-1 {mode === 'review' ? 'btn-primary' : ''}"
					onclick={() => setSessionMode('review')}>Review</button
				>
			</div>

			<div class="join mb-4 w-full">
				{#each KIND_OPTIONS as k (k.id)}
					<button
						class="btn join-item flex-1 px-2 {kind === k.id ? 'btn-primary' : ''}"
						onclick={() => (kind = k.id)}
					>
						<k.icon size={16} /> <span class="hidden sm:inline">{k.label}</span>
					</button>
				{/each}
			</div>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">Project</legend>
				<select class="select w-full" bind:value={cwd}>
					{#each projectGroups as pg (pg.name)}
						<optgroup label={pg.name}>
							{#each pg.projects as p (p.path)}
								<option value={p.path}>{p.name} ({p.path})</option>
							{/each}
						</optgroup>
					{/each}
					<option value="__custom">Custom path...</option>
				</select>
				{#if cwd === '__custom'}
					<PathInput placeholder="/absolute/path or ~/path" bind:value={customCwd} />
				{/if}
				<datalist id="new-session-project-groups">
					{#each groupSuggestions as g (g)}
						<option value={g}></option>
					{/each}
				</datalist>
				<div class="mt-1 flex w-full gap-1">
					<div class="min-w-0 flex-1">
						<PathInput
							class="input input-sm w-full"
							placeholder="register a project path"
							bind:value={newProjectPath}
							onenter={addProject}
						/>
					</div>
					<button class="btn btn-sm" onclick={addProject}>Add</button>
				</div>
				{#if newProjectPath.trim()}
					<input
						class="input input-sm w-full"
						placeholder="group (optional)"
						list="new-session-project-groups"
						bind:value={newProjectGroup}
					/>
					<textarea
						class="textarea textarea-sm w-full"
						rows="2"
						placeholder="template first prompt for this project (optional)"
						bind:value={newProjectTemplate}
					></textarea>
					<p class="text-xs opacity-50">placeholders: {SESSION_PLACEHOLDERS}</p>
				{/if}
			</fieldset>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">
					Title {#if !titleRequired}<span class="opacity-50">(optional)</span>{/if}
				</legend>
				<div class="flex w-full gap-1">
					<input
						class="input min-w-0 flex-1 {titleRequired && !title.trim() ? 'input-error' : ''}"
						placeholder={titleRequired ? 'required' : 'auto-named after a starship if blank'}
						bind:value={title}
					/>
					{#if projectHasSources && !reviewMode}
						<button
							class="btn {showPicker ? 'btn-active' : ''}"
							onclick={() => (showPicker = !showPicker)}
						>
							<Ticket size={16} /> <span class="hidden sm:inline">From issue</span>
						</button>
					{/if}
				</div>
				{#if pickedIssues.length}
					<div class="mt-1 flex flex-wrap items-center gap-1 text-xs">
						<span class="opacity-60">issue{pickedIssues.length > 1 ? 's' : ''}:</span>
						{#each pickedIssues as i (issueKey(i))}
							<button
								class="btn btn-ghost btn-xs gap-1 font-mono"
								onclick={() => pickIssue(i)}
								title="remove"
							>
								{i.id} <X size={12} />
							</button>
						{/each}
					</div>
				{/if}
				{#each pickedIssues as i (issueKey(i))}
					{#if i.blockers.length}
						<div class="alert alert-warning mt-1 items-start py-1 text-xs">
							<TriangleAlert size={14} class="mt-0.5 shrink-0" />
							<div class="min-w-0">
								<div class="font-medium">
									<span class="font-mono">{i.id}</span>: {i.blockers.length} incomplete blocker(s) — you
									can still start.
								</div>
								{#each i.blockers as b (b.id)}
									<div class="truncate"><span class="font-mono">{b.id}</span> {b.title}</div>
								{/each}
							</div>
						</div>
					{/if}
				{/each}
				{#if showPicker && selectedProject}
					<div class="mt-1">
						<IssuePicker project={selectedProject} selected={pickedIssues} onpick={pickIssue} />
					</div>
				{/if}
			</fieldset>

			{#if reviewMode}
				<fieldset class="fieldset">
					<legend class="fieldset-legend">Pull request</legend>
					{#if pickedPr}
						<div class="mt-1 flex items-center gap-2 text-xs">
							<span class="opacity-60">reviewing:</span>
							<span class="shrink-0 font-mono">#{pickedPr.number}</span>
							<span class="min-w-0 flex-1 truncate">{pickedPr.title}</span>
							<button class="btn btn-ghost btn-xs shrink-0 gap-1" onclick={() => (pickedPr = null)}>
								<X size={12} /> clear
							</button>
						</div>
					{/if}
					{#if selectedProject}
						<div class="mt-1">
							<PrPicker project={selectedProject} picked={pickedPr} onpick={pickPr} />
						</div>
					{:else}
						<p class="text-xs opacity-60">pick a project first</p>
					{/if}
				</fieldset>
			{:else}
				<fieldset class="fieldset">
					<legend class="fieldset-legend">Worktree</legend>
					<div class="join w-full">
						<button
							class="btn join-item btn-sm flex-1 {worktreeMode === 'none' ? 'btn-active' : ''}"
							onclick={() => setMode('none')}>None</button
						>
						<button
							class="btn join-item btn-sm flex-1 {worktreeMode === 'existing' ? 'btn-active' : ''}"
							onclick={() => setMode('existing')}>Existing</button
						>
						<button
							class="btn join-item btn-sm flex-1 {worktreeMode === 'new' ? 'btn-active' : ''}"
							onclick={() => setMode('new')}>New</button
						>
					</div>
					{#if worktreeMode === 'existing'}
						{#if existingWorktrees.length}
							<select class="select w-full" bind:value={existingWorktreeDir}>
								{#each existingWorktrees as w (w.path)}
									<option value={w.path}>{w.branch} — {w.path}</option>
								{/each}
							</select>
						{:else}
							<p class="text-xs opacity-60">no existing worktrees for this repo</p>
						{/if}
					{:else if worktreeMode === 'new'}
						<input
							class="input w-full"
							placeholder="branch name (defaults to title)"
							bind:value={branch}
							oninput={() => (branchDirty = true)}
						/>
						<label class="label cursor-pointer justify-start gap-2">
							<input type="checkbox" class="checkbox checkbox-sm" bind:checked={newBranch} />
							<span>New branch</span>
						</label>
						{#if newBranch}
							<select class="select w-full" bind:value={base} onchange={() => (baseDirty = true)}>
								<option value="">base: default branch</option>
								{#if base && !branches.includes(base)}
									<option value={base}>base: {base}</option>
								{/if}
								{#each branches as b (b)}
									<option value={b}>base: {b}</option>
								{/each}
							</select>
						{/if}
					{/if}
				</fieldset>
			{/if}

			{#if kind === 'shell'}
				<fieldset class="fieldset">
					<legend class="fieldset-legend">Shell</legend>
					<input
						class="input w-full"
						placeholder="command (optional, default: your shell)"
						bind:value={command}
					/>
				</fieldset>
			{:else}
				<fieldset class="fieldset">
					<legend class="fieldset-legend">{kind}</legend>
					{#if kind === 'claude'}
						<select class="select w-full" bind:value={model}>
							<option value="">default model</option>
							{#each CLAUDE_MODELS as m (m)}
								<option value={m}>{m}</option>
							{/each}
						</select>
						<label class="label cursor-pointer justify-start gap-2">
							<input type="checkbox" class="checkbox checkbox-sm" bind:checked={yolo} />
							<span>YOLO mode (bypass permissions)</span>
						</label>
					{:else if kind === 'pi'}
						<input
							class="input w-full"
							placeholder="provider (optional, e.g. anthropic, google)"
							bind:value={provider}
						/>
						<input
							class="input w-full"
							placeholder="model (optional, pi pattern or id)"
							bind:value={model}
						/>
					{:else}
						<input
							class="input w-full"
							placeholder="model (optional, e.g. gpt-5-codex)"
							bind:value={model}
						/>
					{/if}
					<textarea
						class="textarea w-full"
						rows="3"
						placeholder="first prompt (optional, starts immediately)"
						bind:value={prompt}
						oninput={() => (promptDirty = true)}
					></textarea>
					{#if reviewMode && selectedProject?.reviewPrompt && !promptDirty}
						<p class="text-xs opacity-50">prefilled from {selectedProject.name} review prompt</p>
					{:else if !reviewMode && selectedProject?.template && !promptDirty}
						<p class="text-xs opacity-50">prefilled from {selectedProject.name} template</p>
					{:else if reviewMode}
						<p class="text-xs opacity-50">placeholders: {REVIEW_PLACEHOLDERS} [cwd]</p>
					{:else}
						<p class="text-xs opacity-50">placeholders: {SESSION_PLACEHOLDERS}</p>
					{/if}
				</fieldset>
			{/if}

			{#if errorMsg}
				<div class="alert alert-error mt-3 py-2 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={() => (open = false)}>Cancel</button>
				<button
					class="btn btn-primary"
					onclick={create}
					disabled={busy || (titleRequired && !title.trim()) || (reviewMode && !pickedPr)}
				>
					{busy ? 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (open = false)} aria-label="close"></button>
	</div>
{/if}
