<script lang="ts">
	import type { Project } from '$lib/types';
	import { shortPath } from '$lib/time';
	import PathInput from '$lib/components/PathInput.svelte';
	import IssueSources from '$lib/components/IssueSources.svelte';
	import { ArrowLeft, Plus, Trash2, Check } from '@lucide/svelte';

	let projects = $state<Project[]>([]);
	let loaded = $state(false);
	let savedPath = $state<string | null>(null);

	let newPath = $state('');
	let newName = $state('');
	let newTemplate = $state('');
	let errorMsg = $state('');

	async function load() {
		const res = await fetch('/api/projects');
		if (res.ok) projects = await res.json();
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
			body: JSON.stringify({ path: p.path, name: p.name, template: p.template, lastBase: p.lastBase })
		});
		if (!res.ok) {
			errorMsg = (await res.json()).message ?? 'failed to save';
			return;
		}
		savedPath = p.path;
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
				template: newTemplate.trim() || undefined
			})
		});
		if (!res.ok) {
			errorMsg = (await res.json()).message ?? 'failed to add';
			return;
		}
		newPath = '';
		newName = '';
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
	<div class="space-y-3">
		{#each projects as p (p.path)}
			<div class="rounded-box border border-base-300 bg-base-100 p-4">
				<div class="mb-2 flex items-center gap-2">
					<input class="input input-sm flex-1 font-medium" bind:value={p.name} />
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
				<input
					class="input input-sm mt-2 w-full sm:w-72"
					placeholder="default base branch (remembered automatically)"
					bind:value={p.lastBase}
				/>
				<div class="mt-1 flex items-center gap-2">
					<span class="text-xs opacity-50">placeholders: [title] [branch-name] [base-branch] [cwd] [issue_id] [issue_url]</span>
					<div class="flex-1"></div>
					{#if savedPath === p.path}
						<span class="flex items-center gap-1 text-xs text-success"><Check size={14} /> saved</span>
					{/if}
					<button class="btn btn-sm btn-primary" onclick={() => save(p)}>Save</button>
				</div>
				<IssueSources project={p} onchanged={load} />
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
