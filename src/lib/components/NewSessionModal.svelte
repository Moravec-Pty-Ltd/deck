<script lang="ts">
	import { isAgentKind } from '$lib/types';
	import type {
		DeckSettings,
		Issue,
		ModelChoice,
		NewSessionPreset,
		Project,
		PullRequest,
		SessionKind
	} from '$lib/types';
	import { groupProjects, existingGroupNames } from '$lib/groups';
	import { CLAUDE_MODELS, resolveModelChoice, shouldReseedModel } from '$lib/models';
	import { SESSION_PLACEHOLDERS, REVIEW_PLACEHOLDERS } from '$lib/placeholders';
	import { firstAgentPrompt, isLegacyWorkflowId, resolveWorkflows } from '$lib/workflows-core';
	import { Bot, Terminal, Sparkles, Braces, SquareCode, Ticket, X, TriangleAlert } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import PathInput from './PathInput.svelte';
	import IssuePicker from './IssuePicker.svelte';
	import PrPicker from './PrPicker.svelte';
	import ComboInput from './ComboInput.svelte';

	const KIND_OPTIONS = [
		{ id: 'claude', label: 'Claude', icon: Bot },
		{ id: 'pi', label: 'pi', icon: Sparkles },
		{ id: 'codex', label: 'codex', icon: Braces },
		{ id: 'opencode', label: 'opencode', icon: SquareCode },
		{ id: 'shell', label: 'Shell', icon: Terminal }
	] as const;

	let { open = $bindable(false), preset = null }: { open?: boolean; preset?: NewSessionPreset | null } =
		$props();

	type Worktree = { path: string; branch: string; isMain: boolean };
	type WorktreeMode = 'none' | 'existing' | 'new';

	// The selected workflow replaces the old New/Review toggle (issue #111): its
	// `context` drives the picker, token hints, and worktree behaviour. Projects
	// without configured workflows get the synthesized legacy pair, which
	// behaves exactly like the old two modes.
	let workflowId = $state<string>('');
	let kind = $state<SessionKind>('claude');
	let projects = $state<Project[]>([]);
	let cwd = $state('');
	let customCwd = $state('');
	let title = $state('');
	let model = $state('');
	let provider = $state('');
	let modelDirty = $state(false);
	let settings = $state<DeckSettings>({});
	// Detected model lists per agent kind, fetched once per session and reused
	// (issue #51). Missing key = not fetched yet; empty array = CLI reported none.
	let modelCache = $state<Record<string, ModelChoice[]>>({});
	// The kind and project the model/provider fields were last seeded for; a
	// change to either means the prior pick belongs to a different agent or
	// project and must be re-seeded.
	let seededKind: SessionKind | null = null;
	let seededProjectPath: string | undefined = undefined;
	// Which agent CLIs are installed (GET /api/agents/available). null until the
	// fetch lands or if it failed — both mean "show every kind" (fail-soft), so a
	// harness is only hidden once we positively know it's absent.
	let availability = $state<Partial<Record<SessionKind, boolean>> | null>(null);
	// Bumped on each init() so a slow availability response from a prior open can't
	// land after a reopen and clobber the current one with stale data.
	let availabilitySeq = 0;
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
		modelDirty = false;
		seededKind = null;
		seededProjectPath = undefined;
		errorMsg = '';
		showPicker = false;
		workflowId = '';
		pickedIssues = [];
		pickedPr = null;
		availability = null;
		const seq = ++availabilitySeq;
		fetch('/api/agents/available')
			.then((r) => r.json())
			.then((a: Partial<Record<SessionKind, boolean>>) => {
				if (seq !== availabilitySeq) return;
				availability = a && typeof a === 'object' && !Array.isArray(a) ? a : null;
			})
			.catch(() => {
				if (seq === availabilitySeq) availability = null;
			});
		const p = preset;
		worktreeModeDirty = !!(p?.kind || p?.cwd);
		fetch('/api/settings')
			.then((r) => r.json())
			.then((s: DeckSettings) => (settings = s ?? {}))
			.catch(() => {});
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
	const titleRequired = $derived(isAgentKind(kind));
	const projectHasSources = $derived(!!selectedProject?.sources?.length);

	// The project's workflows (configured, or the synthesized legacy pair). The
	// selection falls back to the first entry whenever the stored id doesn't
	// exist under the (possibly just switched) project.
	const workflows = $derived(resolveWorkflows(selectedProject));
	const workflow = $derived(workflows.find((w) => w.id === workflowId) ?? workflows[0]);
	const context = $derived(workflow.context);
	const reviewMode = $derived(context === 'pr');
	// 'worktree' context pins the existing-worktree picker; 'none' pins no
	// worktree; 'issue' keeps the free choice (defaulted per kind below).
	const effectiveWorktreeMode = $derived<WorktreeMode>(
		context === 'worktree' ? 'existing' : context === 'none' ? 'none' : worktreeMode
	);
	const finalCwd = $derived(effectiveWorktreeMode === 'existing' ? existingWorktreeDir : effectiveCwd);

	// shell always shows; an agent kind shows unless availability positively says
	// it's absent. availability === null (pre-fetch or failed) reveals everything,
	// so a transient error never hides the whole agent set.
	const shownKinds = $derived(
		KIND_OPTIONS.filter((k) => k.id === 'shell' || !availability || availability[k.id] !== false)
	);

	// If detection hides the currently selected kind (the 'claude' default, a
	// preset's kind, or the prior pick), re-point to the first shown option so the
	// selection is never an invisible kind.
	$effect(() => {
		if (availability && !shownKinds.some((k) => k.id === kind)) {
			kind = shownKinds[0]?.id ?? 'shell';
		}
	});

	function pickWorkflow(id: string) {
		workflowId = id;
		// Keep the flows from leaking picks into each other: an issue pick
		// belongs to issue-context workflows, a PR pick to pr-context ones.
		const ctx = workflows.find((w) => w.id === id)?.context;
		if (ctx !== 'issue') {
			pickedIssues = [];
			showPicker = false;
		}
		if (ctx !== 'pr') pickedPr = null;
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

	// Prefill the first prompt until the user edits it: the selected workflow's
	// first agent-step prompt (for the legacy pair that's exactly the old
	// template/reviewPrompt). Empty means an empty field, same as today.
	$effect(() => {
		const template = firstAgentPrompt(workflow);
		if (!promptDirty) prompt = template;
	});

	// Branch defaults to the title until the user edits it.
	$effect(() => {
		if (effectiveWorktreeMode === 'new' && !branchDirty) branch = title.trim();
	});

	// Base branch defaults to the project's remembered last base.
	$effect(() => {
		if (!baseDirty) base = selectedProject?.lastBase ?? '';
	});

	// Models the CLI reports for the active agent kind (empty until fetched or if
	// detection failed — the fields then stay plain free-text).
	const detectedModels = $derived<ModelChoice[]>(modelCache[kind] ?? []);
	const piProviders = $derived([
		...new Set(detectedModels.map((m) => m.provider).filter((p): p is string => !!p))
	]);
	// pi's model list, narrowed to the typed provider when one is set so the
	// suggestions stay relevant.
	const piModels = $derived(
		(provider ? detectedModels.filter((m) => m.provider === provider) : detectedModels).map(
			(m) => m.model
		)
	);
	const opencodeModels = $derived(detectedModels.map((m) => m.model));

	// Model/provider default to the project's last pick for this kind, then the
	// global last-used, then the built-in default (claude -> opus, others blank).
	// Re-seed on a kind change (prior text belongs to a different agent) or a
	// genuine project switch (the pick is project-scoped, like issue/PR/base),
	// but never clobber a hand-edited value within the same kind+project.
	$effect(() => {
		const projectPath = selectedProject?.path;
		if (shouldReseedModel({ kind: seededKind, projectPath: seededProjectPath }, { kind, projectPath }))
			modelDirty = false;
		seededKind = kind;
		seededProjectPath = projectPath;
		if (modelDirty) return;
		const choice = isAgentKind(kind)
			? resolveModelChoice(kind, selectedProject, settings)
			: { model: '', provider: undefined };
		model = choice.model;
		provider = choice.provider ?? '';
	});

	// Fetch the detected model list once per agent kind while the modal is open;
	// fail-soft to an empty list so the picker degrades to free-text.
	$effect(() => {
		if (!open || (kind !== 'pi' && kind !== 'opencode') || modelCache[kind]) return;
		const k = kind;
		fetch(`/api/agents/${k}/models`)
			.then((r) => r.json())
			.then((list: ModelChoice[]) => {
				modelCache = { ...modelCache, [k]: Array.isArray(list) ? list : [] };
			})
			.catch(() => (modelCache = { ...modelCache, [k]: [] }));
	});

	$effect(() => {
		if (effectiveWorktreeMode === 'new' && effectiveCwd) {
			fetch(`/api/git/branches?repo=${encodeURIComponent(effectiveCwd)}`)
				.then((r) => r.json())
				.then((b: string[]) => (branches = Array.isArray(b) ? b : []));
		}
	});

	$effect(() => {
		if (effectiveWorktreeMode === 'existing' && effectiveCwd) {
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
		if (!reviewMode && effectiveWorktreeMode === 'existing' && !existingWorktreeDir) {
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
					// A configured workflow starts a run on the session; the legacy
					// synthesized pair keeps the plain first-prompt dispatch.
					workflowId:
						kind !== 'shell' && !isLegacyWorkflowId(workflow.id) ? workflow.id : undefined,
					worktree:
						reviewMode && pickedPr
							? { fromPr: pickedPr.number, base: pickedPr.baseRefName }
							: effectiveWorktreeMode === 'new' && branch.trim()
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

			{#if workflows.length <= 3}
				<div class="join mb-4 w-full">
					{#each workflows as w (w.id)}
						<button
							class="btn join-item flex-1 {workflow.id === w.id ? 'btn-primary' : ''}"
							onclick={() => pickWorkflow(w.id)}>{w.name}</button
						>
					{/each}
				</div>
			{:else}
				<select
					class="select mb-4 w-full"
					value={workflow.id}
					onchange={(e) => pickWorkflow(e.currentTarget.value)}
				>
					{#each workflows as w (w.id)}
						<option value={w.id}>{w.name}</option>
					{/each}
				</select>
			{/if}

			<div class="join mb-4 w-full">
				{#each shownKinds as k (k.id)}
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
					{#if projectHasSources && context === 'issue'}
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
			{:else if context === 'worktree'}
				<fieldset class="fieldset">
					<legend class="fieldset-legend">Worktree</legend>
					{#if existingWorktrees.length}
						<select class="select w-full" bind:value={existingWorktreeDir}>
							{#each existingWorktrees as w (w.path)}
								<option value={w.path}>{w.branch} — {w.path}</option>
							{/each}
						</select>
					{:else}
						<p class="text-xs opacity-60">no existing worktrees for this repo</p>
					{/if}
				</fieldset>
			{:else if context === 'issue'}
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
						<select class="select w-full" bind:value={model} onchange={() => (modelDirty = true)}>
							{#each CLAUDE_MODELS as m (m)}
								<option value={m}>{m}</option>
							{/each}
						</select>
						<label class="label cursor-pointer justify-start gap-2">
							<input type="checkbox" class="checkbox checkbox-sm" bind:checked={yolo} />
							<span>YOLO mode (bypass permissions)</span>
						</label>
					{:else if kind === 'pi'}
						<ComboInput
							bind:value={provider}
							options={piProviders}
							placeholder="provider (optional, e.g. anthropic, google)"
							oninput={() => (modelDirty = true)}
						/>
						<ComboInput
							bind:value={model}
							options={piModels}
							placeholder="model (optional, pi pattern or id)"
							oninput={() => (modelDirty = true)}
						/>
					{:else if kind === 'opencode'}
						<ComboInput
							bind:value={model}
							options={opencodeModels}
							placeholder="model (optional, provider/model e.g. anthropic/claude-sonnet-4-5)"
							oninput={() => (modelDirty = true)}
						/>
					{:else}
						<input
							class="input w-full"
							placeholder="model (optional, e.g. gpt-5-codex)"
							bind:value={model}
							oninput={() => (modelDirty = true)}
						/>
					{/if}
					<textarea
						class="textarea w-full"
						rows="3"
						placeholder="first prompt (optional, starts immediately)"
						bind:value={prompt}
						oninput={() => (promptDirty = true)}
					></textarea>
					{#if !isLegacyWorkflowId(workflow.id)}
						<p class="text-xs opacity-50">
							runs the "{workflow.name}" workflow ({workflow.steps.length} step{workflow.steps
								.length === 1
								? ''
								: 's'}); this prompt is its first agent step
						</p>
					{:else if !promptDirty && firstAgentPrompt(workflow)}
						<p class="text-xs opacity-50">
							prefilled from {selectedProject?.name}
							{reviewMode ? 'review prompt' : 'template'}
						</p>
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
