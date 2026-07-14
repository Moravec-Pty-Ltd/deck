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
	import {
		CLAUDE_MODELS,
		isExpensiveModel,
		resolveModelChoice,
		shouldReseedModel
	} from '$lib/models';
	import { SESSION_PLACEHOLDERS, REVIEW_PLACEHOLDERS } from '$lib/placeholders';
	import { firstAgentPrompt, isLegacyWorkflowId, resolveWorkflows } from '$lib/workflows-core';
	import {
		Bot,
		Terminal,
		Braces,
		SquareCode,
		Ticket,
		X,
		TriangleAlert,
		ChevronDown,
		Plus,
		SlidersHorizontal
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import PathInput from './PathInput.svelte';
	import IssuePicker from './IssuePicker.svelte';
	import PrPicker from './PrPicker.svelte';
	import ComboInput from './ComboInput.svelte';
	import PiGlyph from './PiGlyph.svelte';

	const KIND_OPTIONS = [
		{ id: 'claude', label: 'Claude', icon: Bot },
		{ id: 'pi', label: 'pi', icon: PiGlyph },
		{ id: 'codex', label: 'codex', icon: Braces },
		{ id: 'opencode', label: 'opencode', icon: SquareCode },
		{ id: 'shell', label: 'Shell', icon: Terminal }
	] as const;

	let { open = $bindable(false), preset = null }: { open?: boolean; preset?: NewSessionPreset | null } =
		$props();

	type Worktree = { path: string; branch: string; isMain: boolean };
	type WorktreeMode = 'none' | 'existing' | 'new';

	// The selected workflow replaces the old New/Review toggle (issue #111): its
	// `context` drives the picker, token hints, and worktree behaviour. Every
	// project offers the synthesized legacy New/Review pair (which behaves
	// exactly like the old two modes) ahead of any configured workflows, so the
	// plain-session path is always available (issue #113).
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
	// The expensive-model confirm is showing (a fable/sol pick is awaiting a
	// decision). `confirmedExpensive` is the explicit go-ahead, set only by the
	// confirm's own button, so a stray re-invoke of create() (e.g. Enter on the
	// still-focused Create button behind the modal) can't skip the gate (issue #134).
	let confirmingExpensive = $state(false);
	let confirmedExpensive = $state(false);
	let showPicker = $state(false);
	let pickedIssues = $state<Issue[]>([]);
	let pickedPrs = $state<PullRequest[]>([]);
	// Split a multi-item selection into one session per item (loop the create).
	// Work defaults to combine (one session, all issues); review always splits
	// (one session per PR — no multi-PR worktree). Only offered for work.
	let split = $state(false);
	// Per-item progress shown on the Create button while a split batch runs.
	let createProgress = $state('');
	// Progressive disclosure: worktree/model/permission controls fold away since
	// their defaults are right nearly every time; the digest line keeps them
	// legible while collapsed. Registering a project is rarer still.
	let showOptions = $state(false);
	let addingProject = $state(false);

	const issueKey = (i: Issue) => `${i.sourceId}:${i.id}`;
	const prKey = (p: PullRequest) => `${p.sourceId}:${p.number}`;
	// Mirror the server's ISSUE_CAP (POST /api/sessions) so the selection can't
	// grow past what actually gets persisted and fetched.
	const MAX_ISSUES = 10;
	// Review splits into one session per PR; cap the fan-out like issues.
	const MAX_PRS = 10;
	// The modal-level title for a PR selection: the PR's own title for a single
	// pick (unchanged), else the refs joined so the field reads sensibly.
	const prTitleField = (list: PullRequest[]) =>
		list.length === 1 ? list[0].title : list.map((p) => `#${p.number}`).join('+');

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
		confirmingExpensive = false;
		confirmedExpensive = false;
		showPicker = false;
		showOptions = false;
		addingProject = false;
		workflowId = '';
		pickedIssues = [];
		pickedPrs = [];
		split = false;
		createProgress = '';
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
	// Whether this create fans out into one session per item. Review always splits
	// (no multi-PR worktree); work splits only when the user opts in and there's
	// more than one issue to split.
	const splitIssues = $derived(context === 'issue' && split && pickedIssues.length > 1);
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
		if (ctx !== 'pr') pickedPrs = [];
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

	// Toggle a PR in/out of the selection (mirrors pickIssue). Review always
	// splits, so each picked PR becomes its own session; the title tracks the
	// picks so a single PR still reads as its own title, as before.
	function pickPr(pr: PullRequest) {
		const k = prKey(pr);
		const has = pickedPrs.some((p) => prKey(p) === k);
		if (!has && pickedPrs.length >= MAX_PRS) {
			errorMsg = `attach at most ${MAX_PRS} PRs`;
			return;
		}
		errorMsg = '';
		pickedPrs = has ? pickedPrs.filter((p) => prKey(p) !== k) : [...pickedPrs, pr];
		title = prTitleField(pickedPrs);
	}

	// Drop any picked issue/PR when the project changes — a pick from one project
	// must not ride along into a session created under another.
	$effect(() => {
		cwd;
		pickedIssues = [];
		pickedPrs = [];
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
	// The picked model as the expensive-model warning/confirm should name it: pi
	// keeps provider and model separate (an expensive match can come from either),
	// so show `provider/model`; the other kinds carry the whole id in `model`.
	// provider is a pi-only concept (only pi sends it on create), so treat it as
	// unset for other kinds in the expensive check and its label — a stale
	// remembered provider must not sway the warning for claude/codex/opencode.
	const effectiveProvider = $derived(kind === 'pi' ? provider : '');
	const pickedModelLabel = $derived([effectiveProvider, model].filter(Boolean).join('/'));
	const expensivePick = $derived(isAgentKind(kind) && isExpensiveModel(model, effectiveProvider));

	// The collapsed Options row and its one-line digest of what the defaults
	// will do: worktree plan, model, and (for claude) the permission mode.
	const hasOptions = $derived(isAgentKind(kind) || context === 'issue');
	const worktreeLabel = $derived(
		reviewMode
			? 'PR worktree'
			: effectiveWorktreeMode === 'new'
				? `new worktree${base ? ` off ${base}` : ''}`
				: effectiveWorktreeMode === 'existing'
					? 'existing worktree'
					: 'no worktree'
	);
	const optionsSummary = $derived(
		[
			worktreeLabel,
			isAgentKind(kind) ? pickedModelLabel || 'default model' : '',
			kind === 'claude' ? (yolo ? 'yolo' : 'ask first') : ''
		]
			.filter(Boolean)
			.join(' · ')
	);

	// If the pick stops being expensive while the confirm is open (a background
	// control stays reachable behind the div-modal), drop the stale dialog so an
	// "Expensive model" prompt never lingers on a now-cheap selection (issue #134).
	$effect(() => {
		if (confirmingExpensive && !expensivePick) {
			confirmingExpensive = false;
			confirmedExpensive = false;
		}
	});

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
			addingProject = false;
		} else {
			errorMsg = (await res.json()).message ?? 'failed to add project';
		}
	}

	type Create = { key: string; label: string; body: Record<string, unknown> };

	// Build the create request(s) for this submit. Review always splits into one
	// body per PR; work makes one combined body (all issues) unless splitting,
	// which makes one body per issue. `key` ties a body back to its source item so
	// a partial-failure retry only re-fires the ones that failed.
	function buildCreates(startCwd: string): Create[] {
		const common = {
			kind,
			model: model.trim() || undefined,
			provider: kind === 'pi' && provider.trim() ? provider.trim() : undefined,
			permissionMode: kind === 'claude' ? (yolo ? 'bypassPermissions' : 'acceptEdits') : undefined,
			command: kind === 'shell' && command.trim() ? command.trim() : undefined,
			prompt: kind !== 'shell' && prompt.trim() ? prompt.trim() : undefined,
			// A configured workflow starts a run on the session; the legacy
			// synthesized pair keeps the plain first-prompt dispatch.
			workflowId: kind !== 'shell' && !isLegacyWorkflowId(workflow.id) ? workflow.id : undefined
		};
		if (reviewMode) {
			return pickedPrs.map((pr) => ({
				key: prKey(pr),
				label: `#${pr.number}`,
				body: {
					...common,
					cwd: startCwd,
					title: pickedPrs.length === 1 ? title.trim() || pr.title : pr.title,
					worktree: { fromPr: pr.number, base: pr.baseRefName },
					pr: { repo: pr.repo, number: pr.number, url: pr.url, title: pr.title }
				}
			}));
		}
		const issueField = (i: Issue) => ({
			source: i.sourceType,
			sourceId: i.sourceId,
			id: i.id,
			url: i.url
		});
		const newWorktree = (b: string) =>
			effectiveWorktreeMode === 'new' && b.trim()
				? { branch: b.trim(), newBranch, base: base || undefined }
				: undefined;
		if (splitIssues) {
			// One session per issue: each gets its own branch/title from the issue
			// ref (matching how a single-issue selection is named today).
			return pickedIssues.map((issue) => ({
				key: issueKey(issue),
				label: issue.id,
				body: {
					...common,
					cwd: startCwd,
					title: issue.id,
					worktree: newWorktree(issue.id),
					issues: [issueField(issue)]
				}
			}));
		}
		return [
			{
				key: 'combined',
				label: 'session',
				body: {
					...common,
					cwd: startCwd,
					title: title.trim() || undefined,
					worktree: newWorktree(branch),
					issues: pickedIssues.length ? pickedIssues.map(issueField) : undefined
				}
			}
		];
	}

	async function postCreate(body: Record<string, unknown>): Promise<string> {
		const res = await fetch('/api/sessions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.message ?? 'failed to create session');
		return data.id as string;
	}

	function finishCreate(id: string) {
		open = false;
		prompt = '';
		title = '';
		branch = '';
		pickedIssues = [];
		pickedPrs = [];
		goto(`/s/${encodeURIComponent(id)}`);
	}

	async function create() {
		errorMsg = '';
		if (reviewMode && !pickedPrs.length) {
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
		// Expensive-model gate: a fable/sol pick pops the confirm instead of starting;
		// only an explicit "Start anyway" (confirmedExpensive) gets past, so pressing
		// Enter on the background Create button can't bypass it (issue #134). One
		// confirm covers the whole batch, since every session in it runs the same model.
		if (expensivePick && !confirmedExpensive) {
			confirmingExpensive = true;
			return;
		}
		confirmingExpensive = false;
		confirmedExpensive = false;

		const creates = buildCreates(startCwd);
		busy = true;
		createProgress = '';
		try {
			// Single create: unchanged path — a failure keeps the modal open with the
			// error, success navigates to the new session.
			if (creates.length === 1) {
				finishCreate(await postCreate(creates[0].body));
				return;
			}
			// Split batch: fire concurrently so the slowest create doesn't hold up the
			// rest, tracking progress as each lands. Each create is a normal single-item
			// create (distinct branch/PR ref), so the server-side worktree work doesn't
			// contend.
			let done = 0;
			const results = await Promise.allSettled(
				creates.map(async (c) => {
					const id = await postCreate(c.body);
					createProgress = `created ${++done}/${creates.length}`;
					return id;
				})
			);
			const okIds: string[] = [];
			const succeeded = new Set<string>();
			const failed: string[] = [];
			results.forEach((r, i) => {
				if (r.status === 'fulfilled') {
					okIds.push(r.value);
					succeeded.add(creates[i].key);
				} else {
					const reason = r.reason instanceof Error ? r.reason.message : 'failed';
					failed.push(`${creates[i].label} (${reason})`);
				}
			});
			if (!okIds.length) {
				errorMsg = `failed to create: ${failed.join('; ')}`;
				return;
			}
			// Partial failure: surface it and drop the ones that succeeded from the
			// selection so a retry only re-fires the ones that failed (no duplicates).
			if (failed.length) {
				if (reviewMode) {
					pickedPrs = pickedPrs.filter((p) => !succeeded.has(prKey(p)));
					title = prTitleField(pickedPrs);
				} else {
					pickedIssues = pickedIssues.filter((i) => !succeeded.has(issueKey(i)));
					title = pickedIssues.map((i) => i.id).join('+');
				}
				errorMsg = `created ${okIds.length}, failed: ${failed.join('; ')}`;
				return;
			}
			finishCreate(okIds[0]);
		} catch (e) {
			// The single-create path throws on failure (postCreate rejects on !ok);
			// surface it here so the modal shows why instead of wedging silently.
			errorMsg = e instanceof Error ? e.message : 'failed to create session';
		} finally {
			busy = false;
			createProgress = '';
		}
	}
</script>

{#if open}
	<div class="modal modal-open modal-bottom sm:modal-middle" role="dialog">
		<div class="modal-box max-w-lg overflow-x-hidden">
			<h3 class="mb-4 text-lg font-semibold">New session</h3>

			<!-- One control for the what-to-do pick however many workflows a project
			     has (no join-vs-select swap at 3+): chips that wrap. The active pick
			     is the modal's one orange selection. -->
			<div class="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Workflow">
				{#each workflows as w (w.id)}
					<button
						class="btn btn-sm {workflow.id === w.id ? 'btn-primary' : ''}"
						aria-pressed={workflow.id === w.id}
						onclick={() => pickWorkflow(w.id)}>{w.name}</button
					>
				{/each}
			</div>

			<div class="join mb-4 w-full" role="group" aria-label="Agent">
				{#each shownKinds as k (k.id)}
					<button
						class="btn join-item flex-1 px-2 {kind === k.id ? 'btn-active' : ''}"
						aria-pressed={kind === k.id}
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
				{#if addingProject}
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
				{:else}
					<button
						class="btn btn-ghost btn-xs mt-1 gap-1 self-start opacity-70"
						onclick={() => (addingProject = true)}
					>
						<Plus size={13} /> Register a project
					</button>
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
				{#if context === 'issue' && pickedIssues.length > 1}
					<label class="label mt-1 cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox checkbox-sm" bind:checked={split} />
						<span class="text-xs">Split into {pickedIssues.length} sessions (one per issue)</span>
					</label>
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
					<legend class="fieldset-legend">Pull request{pickedPrs.length > 1 ? 's' : ''}</legend>
					{#if pickedPrs.length}
						<div class="mt-1 flex flex-wrap items-center gap-1 text-xs">
							<span class="opacity-60">reviewing:</span>
							{#each pickedPrs as pr (prKey(pr))}
								<button
									class="btn btn-ghost btn-xs gap-1 font-mono"
									onclick={() => pickPr(pr)}
									title="remove"
								>
									#{pr.number} <X size={12} />
								</button>
							{/each}
						</div>
						{#if pickedPrs.length > 1}
							<p class="mt-1 text-xs opacity-50">creates one review session per PR</p>
						{/if}
					{/if}
					{#if selectedProject}
						<div class="mt-1">
							<PrPicker project={selectedProject} picked={pickedPrs} onpick={pickPr} />
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
					<legend class="fieldset-legend">First prompt <span class="opacity-50">(optional)</span></legend>
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

			{#if hasOptions}
				<!-- Worktree, model, and permission controls: right by default, so they
				     start folded behind a digest of what will happen. -->
				<div class="mt-3 rounded-box border border-base-300">
					<button
						class="flex w-full items-center gap-2 px-3 py-2 text-left"
						onclick={() => (showOptions = !showOptions)}
						aria-expanded={showOptions}
					>
						<SlidersHorizontal size={14} class="shrink-0 opacity-70" />
						<span class="text-sm font-medium">Options</span>
						<span class="min-w-0 flex-1 truncate text-right text-xs opacity-60">{optionsSummary}</span>
						<ChevronDown
							size={14}
							class="shrink-0 opacity-70 transition-transform {showOptions ? 'rotate-180' : ''}"
						/>
					</button>
					{#if showOptions}
						<div class="border-t border-base-300 px-3 pb-3">
							{#if context === 'issue'}
								<fieldset class="fieldset">
									<legend class="fieldset-legend">Worktree</legend>
									<div class="join w-full">
										<button
											class="btn join-item btn-sm flex-1 {worktreeMode === 'none' ? 'btn-active' : ''}"
											aria-pressed={worktreeMode === 'none'}
											onclick={() => setMode('none')}>None</button
										>
										<button
											class="btn join-item btn-sm flex-1 {worktreeMode === 'existing' ? 'btn-active' : ''}"
											aria-pressed={worktreeMode === 'existing'}
											onclick={() => setMode('existing')}>Existing</button
										>
										<button
											class="btn join-item btn-sm flex-1 {worktreeMode === 'new' ? 'btn-active' : ''}"
											aria-pressed={worktreeMode === 'new'}
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
							{#if isAgentKind(kind)}
								<fieldset class="fieldset">
									<legend class="fieldset-legend">Model</legend>
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
								</fieldset>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			{#if expensivePick}
				<!-- Outside the collapse: the cost flag must be visible while Options is
				     folded, since the remembered default can itself be expensive. -->
				<div class="alert alert-warning mt-3 items-start py-1 text-xs">
					<TriangleAlert size={14} class="mt-0.5 shrink-0" />
					<span>
						<span class="font-mono">{pickedModelLabel}</span> is an expensive model; you'll be asked
						to confirm before it starts.
					</span>
				</div>
			{/if}

			{#if errorMsg}
				<div class="alert alert-error mt-3 py-2 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={() => (open = false)}>Cancel</button>
				<button
					class="btn btn-primary"
					onclick={create}
					disabled={busy || (titleRequired && !title.trim()) || (reviewMode && !pickedPrs.length)}
				>
					{busy ? createProgress || 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (open = false)} aria-label="close"></button>
	</div>

	{#if confirmingExpensive}
		<div class="modal modal-open modal-bottom sm:modal-middle" role="dialog">
			<div class="modal-box max-w-sm">
				<h3 class="mb-2 flex items-center gap-2 text-lg font-semibold">
					<TriangleAlert size={18} class="text-warning" /> Expensive model
				</h3>
				<p class="mb-3 text-sm opacity-70">
					<span class="font-mono">{pickedModelLabel}</span> is an expensive model. Start this session on
					it anyway?
				</p>
				<div class="modal-action">
					<button
						class="btn"
						onclick={() => {
							confirmingExpensive = false;
							confirmedExpensive = false;
						}}>Cancel</button
					>
					<button
						class="btn btn-warning"
						disabled={busy}
						onclick={() => {
							confirmedExpensive = true;
							create();
						}}>Start anyway</button
					>
				</div>
			</div>
			<button
				class="modal-backdrop"
				onclick={() => {
					confirmingExpensive = false;
					confirmedExpensive = false;
				}}
				aria-label="close"
			></button>
		</div>
	{/if}
{/if}
