<script lang="ts">
	import type { NewSessionPreset, Project, SessionKind } from '$lib/types';
	import { Bot, Terminal } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import PathInput from './PathInput.svelte';

	let { open = $bindable(false), preset = null }: { open?: boolean; preset?: NewSessionPreset | null } =
		$props();

	type Worktree = { path: string; branch: string; isMain: boolean };
	type WorktreeMode = 'none' | 'existing' | 'new';

	let kind = $state<SessionKind>('claude');
	let projects = $state<Project[]>([]);
	let cwd = $state('');
	let customCwd = $state('');
	let title = $state('');
	let model = $state('');
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
	let newProjectTemplate = $state('');
	let busy = $state(false);
	let errorMsg = $state('');

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
	const finalCwd = $derived(worktreeMode === 'existing' ? existingWorktreeDir : effectiveCwd);
	const titleRequired = $derived(kind === 'claude');

	// Worktree mode defaults to "new" for claude (branch off and work in isolation)
	// and "none" for shells (run right in the project), until the user overrides.
	$effect(() => {
		if (!worktreeModeDirty) worktreeMode = kind === 'claude' ? 'new' : 'none';
	});

	function setMode(m: WorktreeMode) {
		worktreeMode = m;
		worktreeModeDirty = true;
	}

	// Prefill the first prompt from the project's template until the user edits it.
	$effect(() => {
		const template = selectedProject?.template ?? '';
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
				template: newProjectTemplate.trim() || undefined
			})
		});
		if (res.ok) {
			const p: Project = await res.json();
			projects = [...projects.filter((x) => x.path !== p.path), p];
			cwd = p.path;
			promptDirty = false;
			newProjectPath = '';
			newProjectTemplate = '';
		} else {
			errorMsg = (await res.json()).message ?? 'failed to add project';
		}
	}

	async function create() {
		errorMsg = '';
		if (titleRequired && !title.trim()) {
			errorMsg = 'title is required';
			return;
		}
		if (worktreeMode === 'existing' && !existingWorktreeDir) {
			errorMsg = 'pick an existing worktree';
			return;
		}
		if (!finalCwd) {
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
					cwd: finalCwd,
					title: title.trim() || undefined,
					model: model || undefined,
					permissionMode:
						kind === 'claude' ? (yolo ? 'bypassPermissions' : 'acceptEdits') : undefined,
					command: kind === 'shell' && command.trim() ? command.trim() : undefined,
					prompt: kind === 'claude' && prompt.trim() ? prompt.trim() : undefined,
					worktree:
						worktreeMode === 'new' && branch.trim()
							? { branch: branch.trim(), newBranch, base: base || undefined }
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
			goto(`/s/${encodeURIComponent(data.id)}`);
		} finally {
			busy = false;
		}
	}
</script>

{#if open}
	<div class="modal modal-open" role="dialog">
		<div class="modal-box max-w-lg">
			<h3 class="mb-4 text-lg font-semibold">New session</h3>

			<div class="join mb-4 w-full">
				<button
					class="btn join-item flex-1 {kind === 'claude' ? 'btn-primary' : ''}"
					onclick={() => (kind = 'claude')}
				>
					<Bot size={16} /> Claude
				</button>
				<button
					class="btn join-item flex-1 {kind === 'shell' ? 'btn-primary' : ''}"
					onclick={() => (kind = 'shell')}
				>
					<Terminal size={16} /> Shell
				</button>
			</div>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">Project</legend>
				<select class="select w-full" bind:value={cwd}>
					{#each projects as p (p.path)}
						<option value={p.path}>{p.name} ({p.path})</option>
					{/each}
					<option value="__custom">Custom path...</option>
				</select>
				{#if cwd === '__custom'}
					<PathInput placeholder="/absolute/path or ~/path" bind:value={customCwd} />
				{/if}
				<div class="mt-1 flex w-full gap-1">
					<PathInput
						class="input input-sm flex-1"
						placeholder="register a project path"
						bind:value={newProjectPath}
						onenter={addProject}
					/>
					<button class="btn btn-sm" onclick={addProject}>Add</button>
				</div>
				{#if newProjectPath.trim()}
					<textarea
						class="textarea textarea-sm w-full"
						rows="2"
						placeholder="template first prompt for this project (optional)"
						bind:value={newProjectTemplate}
					></textarea>
					<p class="text-xs opacity-50">placeholders: [title] [branch] [cwd]</p>
				{/if}
			</fieldset>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">
					Title {#if !titleRequired}<span class="opacity-50">(optional)</span>{/if}
				</legend>
				<input
					class="input w-full {titleRequired && !title.trim() ? 'input-error' : ''}"
					placeholder={titleRequired ? 'required' : 'auto-named after a starship if blank'}
					bind:value={title}
				/>
			</fieldset>

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

			{#if kind === 'claude'}
				<fieldset class="fieldset">
					<legend class="fieldset-legend">Claude</legend>
					<select class="select w-full" bind:value={model}>
						<option value="">default model</option>
						<option value="opus">opus</option>
						<option value="sonnet">sonnet</option>
						<option value="haiku">haiku</option>
					</select>
					<label class="label cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox checkbox-sm" bind:checked={yolo} />
						<span>YOLO mode (bypass permissions)</span>
					</label>
					<textarea
						class="textarea w-full"
						rows="3"
						placeholder="first prompt (optional, starts immediately)"
						bind:value={prompt}
						oninput={() => (promptDirty = true)}
					></textarea>
					{#if selectedProject?.template && !promptDirty}
						<p class="text-xs opacity-50">prefilled from {selectedProject.name} template</p>
					{/if}
				</fieldset>
			{:else}
				<fieldset class="fieldset">
					<legend class="fieldset-legend">Shell</legend>
					<input
						class="input w-full"
						placeholder="command (optional, default: your shell)"
						bind:value={command}
					/>
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
					disabled={busy || (titleRequired && !title.trim())}
				>
					{busy ? 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (open = false)} aria-label="close"></button>
	</div>
{/if}
