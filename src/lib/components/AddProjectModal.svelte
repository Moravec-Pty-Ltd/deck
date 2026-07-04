<script lang="ts">
	import type { Project } from '$lib/types';
	import { repoNameFromUrl, isCloneUrlSafe } from '$lib/repo-url';
	import PathInput from './PathInput.svelte';

	let {
		open = $bindable(false),
		initialGroup = '',
		onadded
	}: { open?: boolean; initialGroup?: string; onadded?: () => void } = $props();

	let newRepoUrl = $state('');
	let newPath = $state('');
	let newName = $state('');
	let newGroup = $state('');
	let errorMsg = $state('');
	let busy = $state(false);
	let nameEdited = $state(false);
	let groupSuggestions = $state<string[]>([]);

	// With a repo url the path field is a parent dir and deck clones into it;
	// empty, it's an existing dir registered as-is (the plain add path).
	const cloning = $derived(newRepoUrl.trim().length > 0);

	// The folder git clone would create; the route re-derives it authoritatively.
	// Gated on isCloneUrlSafe so the preview/name only activate for urls the server
	// would actually accept, rather than teasing a name for an http:// or file:// url.
	const repoName = $derived(
		cloning && isCloneUrlSafe(newRepoUrl) ? repoNameFromUrl(newRepoUrl) : null
	);

	// Preview of the clone destination, matching the parent's separator style so a
	// Windows-style parent renders C:\code\repo, not a mixed C:\code/repo.
	const clonePreview = $derived.by(() => {
		const p = newPath.trim().replace(/[/\\]+$/, '');
		if (!p || !repoName) return '';
		const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
		return `${p}${sep}${repoName}`;
	});

	// Track the derived repo name into the name field until the user edits it,
	// clearing back to empty when the url (and so the derivation) goes away.
	$effect(() => {
		if (!nameEdited) newName = cloning ? (repoName ?? '') : '';
	});

	// Fetch group suggestions from current projects when modal opens.
	$effect(() => {
		if (open) {
			errorMsg = '';
			newRepoUrl = '';
			newPath = '';
			newName = '';
			nameEdited = false;
			newGroup = initialGroup;
			fetch('/api/projects')
				.then((r) => {
					if (!r.ok) return [];
					return r.json();
				})
				.then((list: Project[]) => {
					const names = new Set<string>();
					for (const p of list) {
						const g = p.group?.trim();
						if (g) names.add(g);
					}
					groupSuggestions = [...names].sort();
				})
				.catch(() => {
					groupSuggestions = [];
				});
		}
	});

	async function add() {
		if (busy) return;
		errorMsg = '';
		if (!newPath.trim()) return;
		if (cloning && !repoName) {
			errorMsg = 'enter a valid repo url (https, ssh, git, or scp-style)';
			return;
		}
		busy = true;
		try {
			const res = cloning
				? await fetch('/api/projects/clone', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							url: newRepoUrl.trim(),
							parent: newPath.trim(),
							name: newName.trim() || undefined,
							group: newGroup.trim() || undefined
						})
					})
				: await fetch('/api/projects', {
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
				<legend class="fieldset-legend">Repo URL <span class="opacity-50">(optional)</span></legend>
				<input
					class="input w-full"
					placeholder="https://github.com/acme/web.git (cloned into the path below)"
					bind:value={newRepoUrl}
					onkeydown={(e) => e.key === 'Enter' && add()}
				/>
			</fieldset>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">{cloning ? 'Parent directory' : 'Path'}</legend>
				<PathInput
					class="input w-full"
					placeholder="/absolute/path or ~/path"
					bind:value={newPath}
					onenter={add}
				/>
				{#if cloning}
					<p class="fieldset-label text-xs">
						{#if clonePreview}
							→ clones into <span class="font-mono">{clonePreview}</span>
						{:else if !repoName}
							enter a valid repo url to derive the folder name
						{:else}
							choose the parent directory to clone into
						{/if}
					</p>
				{/if}
			</fieldset>

			<fieldset class="fieldset">
				<legend class="fieldset-legend">Name <span class="opacity-50">(optional)</span></legend>
				<input
					class="input w-full"
					placeholder="defaults to directory name"
					bind:value={newName}
					oninput={() => (nameEdited = true)}
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
				<button
					class="btn btn-primary"
					onclick={add}
					disabled={busy || !newPath.trim() || (cloning && !repoName)}
				>
					{busy ? (cloning ? 'Cloning...' : 'Adding...') : 'Add'}
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (open = false)} aria-label="close"></button>
	</div>
{/if}
