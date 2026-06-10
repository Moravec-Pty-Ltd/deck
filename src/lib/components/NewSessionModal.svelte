<script lang="ts">
	import type { Project } from '$lib/types';
	import { Bot, Terminal } from '@lucide/svelte';
	import { goto } from '$app/navigation';

	let { open = $bindable(false) } = $props();

	let kind = $state<'claude' | 'shell'>('claude');
	let projects = $state<Project[]>([]);
	let cwd = $state('');
	let customCwd = $state('');
	let title = $state('');
	let model = $state('');
	let yolo = $state(true);
	let useWorktree = $state(false);
	let branch = $state('');
	let newBranch = $state(true);
	let base = $state('');
	let branches = $state<string[]>([]);
	let prompt = $state('');
	let promptDirty = $state(false);
	let command = $state('');
	let newProjectPath = $state('');
	let newProjectTemplate = $state('');
	let busy = $state(false);
	let errorMsg = $state('');

	$effect(() => {
		if (open) {
			promptDirty = false;
			fetch('/api/projects')
				.then((r) => r.json())
				.then((p: Project[]) => {
					projects = p;
					if (!cwd && p.length) cwd = p[0].path;
				});
		}
	});

	const effectiveCwd = $derived(cwd === '__custom' ? customCwd : cwd);
	const selectedProject = $derived(projects.find((p) => p.path === cwd));

	// Prefill the first prompt from the project's template until the user edits it.
	$effect(() => {
		const template = selectedProject?.template ?? '';
		if (!promptDirty) prompt = template;
	});

	$effect(() => {
		if (useWorktree && effectiveCwd) {
			fetch(`/api/git/branches?repo=${encodeURIComponent(effectiveCwd)}`)
				.then((r) => r.json())
				.then((b: string[]) => (branches = Array.isArray(b) ? b : []));
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
		if (!effectiveCwd) {
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
					cwd: effectiveCwd,
					title: title.trim() || undefined,
					model: model || undefined,
					permissionMode: kind === 'claude' ? (yolo ? 'bypassPermissions' : 'acceptEdits') : undefined,
					command: kind === 'shell' && command.trim() ? command.trim() : undefined,
					prompt: kind === 'claude' && prompt.trim() ? prompt.trim() : undefined,
					worktree: useWorktree && branch.trim()
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
			useWorktree = false;
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
					<input class="input w-full" placeholder="/absolute/path" bind:value={customCwd} />
				{/if}
				<div class="join mt-1 w-full">
					<input
						class="input join-item input-sm flex-1"
						placeholder="register a project path"
						bind:value={newProjectPath}
					/>
					<button class="btn join-item btn-sm" onclick={addProject}>Add</button>
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
				<legend class="fieldset-legend">Title</legend>
				<input class="input w-full" placeholder="optional" bind:value={title} />
			</fieldset>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">Worktree</legend>
				<label class="label cursor-pointer justify-start gap-2">
					<input type="checkbox" class="checkbox checkbox-sm" bind:checked={useWorktree} />
					<span>Create session in a git worktree</span>
				</label>
				{#if useWorktree}
					<input class="input w-full" placeholder="branch name" bind:value={branch} />
					<label class="label cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox checkbox-sm" bind:checked={newBranch} />
						<span>New branch</span>
					</label>
					{#if newBranch}
						<select class="select w-full" bind:value={base}>
							<option value="">base: default branch</option>
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
				<button class="btn btn-primary" onclick={create} disabled={busy}>
					{busy ? 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (open = false)} aria-label="close"></button>
	</div>
{/if}
