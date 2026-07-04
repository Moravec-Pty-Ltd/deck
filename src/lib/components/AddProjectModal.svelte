<script lang="ts">
	import type { Project } from '$lib/types';
	import { UNGROUPED } from '$lib/groups';
	import PathInput from './PathInput.svelte';
	import { X, Plus } from '@lucide/svelte';

	let {
		open = $bindable(false),
		initialGroup = '',
		onadded
	}: { open?: boolean; initialGroup?: string; onadded?: () => void } = $props();

	let newPath = $state('');
	let newName = $state('');
	let newGroup = $state('');
	let errorMsg = $state('');
	let busy = $state(false);
	let groupSuggestions = $state<string[]>([]);

	// Fetch group suggestions from current projects when modal opens.
	$effect(() => {
		if (open) {
			errorMsg = '';
			newPath = '';
			newName = '';
			newGroup = initialGroup;
			fetch('/api/projects')
				.then((r) => r.json())
				.then((list: Project[]) => {
					const names = new Set<string>();
					for (const p of list) {
						const g = p.group?.trim();
						if (g) names.add(g);
					}
					groupSuggestions = [...names].sort();
				});
		}
	});

	async function add() {
		errorMsg = '';
		if (!newPath.trim()) return;
		busy = true;
		try {
			const res = await fetch('/api/projects', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					path: newPath.trim(),
					name: newName.trim() || undefined,
					group: newGroup.trim() || undefined
				})
			});
			if (!res.ok) {
				errorMsg = (await res.json()).message ?? 'failed to add project';
				return;
			}
			open = false;
			onadded?.();
		} finally {
			busy = false;
		}
	}
</script>

{#if open}
	<div class="modal modal-open" role="dialog">
		<div class="modal-box max-w-lg">
			<h3 class="mb-4 text-lg font-semibold">Add a project</h3>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">Path</legend>
				<PathInput
					class="input w-full"
					placeholder="/absolute/path or ~/path"
					bind:value={newPath}
					onenter={add}
				/>
			</fieldset>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">Name <span class="opacity-50">(optional)</span></legend>
				<input
					class="input w-full"
					placeholder="defaults to directory name"
					bind:value={newName}
				/>
			</fieldset>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">Group <span class="opacity-50">(optional)</span></legend>
				<input
					class="input w-full"
					placeholder="e.g. acme"
					list="add-project-groups"
					bind:value={newGroup}
				/>
				<datalist id="add-project-groups">
					{#each groupSuggestions as g (g)}
						<option value={g}></option>
					{/each}
				</datalist>
			</fieldset>

			{#if errorMsg}
				<div class="alert alert-error mt-3 py-2 text-sm">{errorMsg}</div>
			{/if}

			<div class="modal-action">
				<button class="btn" onclick={() => (open = false)}>Cancel</button>
				<button class="btn btn-primary" onclick={add} disabled={busy || !newPath.trim()}>
					{busy ? 'Adding...' : 'Add'}
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (open = false)} aria-label="close"></button>
	</div>
{/if}
