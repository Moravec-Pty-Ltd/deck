<script lang="ts">
	import type { Project } from '$lib/types';
	import { shortPath } from '$lib/time';
	import { groupProjects, UNGROUPED } from '$lib/groups';
	import { SESSION_PLACEHOLDERS, REVIEW_PLACEHOLDERS } from '$lib/placeholders';
	import PathInput from '$lib/components/PathInput.svelte';
	import IssueSources from '$lib/components/IssueSources.svelte';
	import DevConfigForm from '$lib/components/DevConfigForm.svelte';
	import { ArrowLeft, Plus, Trash2, Check } from '@lucide/svelte';

	let projects = $state<Project[]>([]);
	let loaded = $state(false);
	let savedPath = $state<string | null>(null);

	let newPath = $state('');
	let newName = $state('');
	let newGroup = $state('');
	let newTemplate = $state('');
	let errorMsg = $state('');

	// Section layout is snapshotted at load, not derived live: editing a card's
	// group input mustn't make the card jump between sections mid-keystroke. It
	// re-settles into its new section on save (which reloads).
	let layout = $state<{ name: string; paths: string[] }[]>([]);
	function rebuildLayout() {
		layout = groupProjects(projects).map((g) => ({ name: g.name, paths: g.projects.map((p) => p.path) }));
	}

	// Suggest only committed group names (from the load-time snapshot), so a group
	// you're still typing into a card doesn't show up as an existing one.
	const groupSuggestions = $derived(layout.map((s) => s.name).filter((name) => name !== UNGROUPED));

	async function load() {
		const res = await fetch('/api/projects');
		if (res.ok) projects = await res.json();
		rebuildLayout();
		loaded = true;
	}

	$effect(() => {
		load();
	});

	async function save(p: Project) {
		errorMsg = '';
		const res = await fetch('/api/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				path: p.path,
				name: p.name,
				group: p.group ?? '',
				template: p.template,
				reviewPrompt: p.reviewPrompt ?? '',
				lastBase: p.lastBase
			})
		});
		if (!res.ok) {
			errorMsg = (await res.json()).message ?? 'failed to save';
			return;
		}
		savedPath = p.path;
		// Reload so the card re-settles into its (possibly new) group section and the
		// group suggestions pick up a newly-named group.
		await load();
		setTimeout(() => (savedPath === p.path ? (savedPath = null) : null), 1500);
	}

	async function add() {
		errorMsg = '';
		if (!newPath.trim()) return;
		const res = await fetch('/api/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				path: newPath.trim(),
				name: newName.trim() || undefined,
				group: newGroup.trim() || undefined,
				template: newTemplate.trim() || undefined
			})
		});
		if (!res.ok) {
			errorMsg = (await res.json()).message ?? 'failed to add';
			return;
		}
		newPath = '';
		newName = '';
		newGroup = '';
		newTemplate = '';
		load();
	}

	async function remove(p: Project) {
		if (!confirm(`Remove project "${p.name}"? (does not touch files)`)) return;
		await fetch(`/api/projects?path=${encodeURIComponent(p.path)}`, { method: 'DELETE' });
		load();
	}
</script>

<svelte:head><title>Projects · deck</title></svelte:head>

<div class="mb-4 flex items-center gap-2">
	<a href="/" class="btn btn-ghost btn-sm" aria-label="Back"><ArrowLeft size={16} /></a>
	<h1 class="text-lg font-semibold">Projects</h1>
</div>

{#if errorMsg}
	<div class="alert alert-error mb-3 py-2 text-sm">{errorMsg}</div>
{/if}

{#if !loaded}
	<p class="p-8 text-center opacity-60">Loading...</p>
{:else}
	<datalist id="project-groups">
		{#each groupSuggestions as g (g)}
			<option value={g}></option>
		{/each}
	</datalist>
	<div class="space-y-5">
		{#each layout as section (section.name)}
			<div>
				<h2 class="mb-2 px-1 text-xs font-semibold uppercase tracking-wide opacity-50">
					{section.name}
				</h2>
				<div class="space-y-3">
					{#each section.paths as path (path)}
						{@const p = projects.find((x) => x.path === path)}
						{#if p}
							<div class="rounded-box border border-base-300 bg-base-100 p-4">
								<div class="mb-2 flex items-center gap-2">
									<input class="input input-sm flex-1 font-medium" bind:value={p.name} />
									<input
										class="input input-sm w-40"
										placeholder="group (optional)"
										list="project-groups"
										bind:value={p.group}
									/>
									<button class="btn btn-ghost btn-sm" onclick={() => remove(p)} aria-label="Remove">
										<Trash2 size={15} />
									</button>
								</div>
								<div class="mb-2 truncate font-mono text-xs opacity-50">{shortPath(p.path)}</div>
								<textarea
									class="textarea textarea-sm w-full"
									rows="3"
									placeholder="default first prompt (optional)"
									bind:value={p.template}
								></textarea>
								<textarea
									class="textarea textarea-sm mt-2 w-full"
									rows="3"
									placeholder="review-mode first prompt (optional)"
									bind:value={p.reviewPrompt}
								></textarea>
								<input
									class="input input-sm mt-2 w-full sm:w-72"
									placeholder="default base branch (remembered automatically)"
									bind:value={p.lastBase}
								/>
								<div class="mt-1 flex items-center gap-2">
									<span class="text-xs opacity-50">placeholders: {SESSION_PLACEHOLDERS}; review adds {REVIEW_PLACEHOLDERS}</span>
									<div class="flex-1"></div>
									{#if savedPath === p.path}
										<span class="flex items-center gap-1 text-xs text-success"><Check size={14} /> saved</span>
									{/if}
									<button class="btn btn-sm btn-primary" onclick={() => save(p)}>Save</button>
								</div>
								<IssueSources project={p} onchanged={load} />
								<DevConfigForm project={p} onchanged={load} />
							</div>
						{/if}
					{/each}
				</div>
			</div>
		{/each}

		<div class="rounded-box border border-dashed border-base-300 bg-base-100 p-4">
			<div class="mb-2 flex items-center gap-2">
				<Plus size={16} class="opacity-60" />
				<span class="font-medium">Add a project</span>
			</div>
			<div class="flex flex-col gap-2 sm:flex-row">
				<div class="flex-1">
					<PathInput
						class="input input-sm w-full"
						placeholder="/absolute/path or ~/path"
						bind:value={newPath}
						onenter={add}
					/>
				</div>
				<input class="input input-sm sm:w-40" placeholder="name (optional)" bind:value={newName} />
				<input
					class="input input-sm sm:w-40"
					placeholder="group (optional)"
					list="project-groups"
					bind:value={newGroup}
				/>
			</div>
			<textarea
				class="textarea textarea-sm mt-2 w-full"
				rows="2"
				placeholder="default first prompt (optional)"
				bind:value={newTemplate}
			></textarea>
			<div class="mt-1 flex justify-end">
				<button class="btn btn-sm" onclick={add} disabled={!newPath.trim()}>Add</button>
			</div>
		</div>
	</div>
{/if}
