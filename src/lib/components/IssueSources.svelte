<script lang="ts">
	import type { IssueSource, IssueSourceType, Project } from '$lib/types';
	import { ISSUE_BADGE } from '$lib/issues';
	import { Plus, Trash2, X } from '@lucide/svelte';

	let { project, onchanged }: { project: Project; onchanged: () => void } = $props();

	type LinearTeam = { id: string; name: string; key: string };
	type LinearState = { id: string; name: string; type: string };
	type CuNamed = { id: string; name: string };
	type CuStatus = { status: string; type: string };

	function summary(s: IssueSource): string {
		if (s.type === 'github') return `${s.owner}/${s.repo}`;
		if (s.type === 'linear') return `${s.teamName} · ${s.stateIds.length} state(s)`;
		return `${s.listName} · ${s.statuses.length} status(es)`;
	}

	let addType = $state<'' | IssueSourceType>('');
	let busy = $state(false);
	let errorMsg = $state('');

	// github
	let ghOwner = $state('');
	let ghRepo = $state('');

	// shared key + identity for linear/clickup
	let apiKey = $state('');
	let connected = $state(false);
	let meLabel = $state('');
	let meId = $state<string | number>('');

	// linear cascade
	let linTeams = $state<LinearTeam[]>([]);
	let linTeamId = $state('');
	let linStates = $state<LinearState[]>([]);
	let linStateIds = $state<string[]>([]);

	// clickup cascade
	let cuTeams = $state<CuNamed[]>([]);
	let cuTeamId = $state('');
	let cuSpaces = $state<CuNamed[]>([]);
	let cuSpaceId = $state('');
	let cuFolders = $state<CuNamed[]>([]);
	let cuFolderId = $state(''); // '' = folderless (lists directly under the space)
	let cuLists = $state<CuNamed[]>([]);
	let cuListId = $state('');
	let cuStatuses = $state<CuStatus[]>([]);
	let cuSelected = $state<string[]>([]);

	const linTeamName = $derived(linTeams.find((t) => t.id === linTeamId)?.name ?? '');
	const cuTeamName = $derived(cuTeams.find((t) => t.id === cuTeamId)?.name ?? '');
	const cuSpaceName = $derived(cuSpaces.find((s) => s.id === cuSpaceId)?.name ?? '');
	const cuFolderName = $derived(cuFolders.find((f) => f.id === cuFolderId)?.name ?? '');
	const cuListName = $derived(cuLists.find((l) => l.id === cuListId)?.name ?? '');

	function resetAdd() {
		addType = '';
		busy = false;
		errorMsg = '';
		ghOwner = ghRepo = apiKey = meLabel = '';
		meId = '';
		connected = false;
		linTeams = [];
		linTeamId = '';
		linStates = [];
		linStateIds = [];
		cuTeams = [];
		cuTeamId = cuSpaceId = cuFolderId = cuListId = '';
		cuSpaces = cuFolders = cuLists = [];
		cuStatuses = [];
		cuSelected = [];
	}

	async function meta<T>(type: IssueSourceType, action: string, params: Record<string, unknown> = {}): Promise<T> {
		const res = await fetch('/api/issues/meta', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ type, action, apiKey, ...params })
		});
		if (!res.ok) throw new Error((await res.json()).message ?? 'request failed');
		return res.json();
	}

	async function run(fn: () => Promise<void>) {
		busy = true;
		errorMsg = '';
		try {
			await fn();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : 'request failed';
		} finally {
			busy = false;
		}
	}

	function connectLinear() {
		run(async () => {
			const me = await meta<{ name: string; email: string }>('linear', 'me');
			meLabel = `${me.name} <${me.email}>`;
			meId = me.email;
			linTeams = await meta<LinearTeam[]>('linear', 'teams');
			connected = true;
		});
	}

	function loadLinearStates() {
		// Re-selecting the placeholder option clears the team; don't call the API.
		if (!linTeamId) {
			linStates = [];
			linStateIds = [];
			return;
		}
		run(async () => {
			linStates = await meta<LinearState[]>('linear', 'states', { teamId: linTeamId });
			// Default to the "to do / up next" buckets (unstarted-typed states).
			linStateIds = linStates.filter((s) => s.type === 'unstarted').map((s) => s.id);
		});
	}

	function connectClickup() {
		run(async () => {
			const me = await meta<{ id: number; username: string }>('clickup', 'me');
			meLabel = me.username;
			meId = me.id;
			cuTeams = await meta<CuNamed[]>('clickup', 'teams');
			connected = true;
		});
	}

	function loadSpaces() {
		if (!cuTeamId) {
			cuSpaces = [];
			cuSpaceId = cuFolderId = cuListId = '';
			cuFolders = cuLists = [];
			cuStatuses = [];
			cuSelected = [];
			return;
		}
		run(async () => {
			cuSpaces = await meta<CuNamed[]>('clickup', 'spaces', { teamId: cuTeamId });
			cuSpaceId = cuFolderId = cuListId = '';
			cuFolders = cuLists = [];
			cuStatuses = [];
			cuSelected = [];
		});
	}

	function loadFoldersAndLists() {
		if (!cuSpaceId) {
			cuFolders = [];
			cuLists = [];
			cuFolderId = '';
			cuListId = '';
			cuStatuses = [];
			cuSelected = [];
			return;
		}
		run(async () => {
			cuFolders = await meta<CuNamed[]>('clickup', 'folders', { spaceId: cuSpaceId });
			cuFolderId = '';
			await loadListsInner();
		});
	}

	async function loadListsInner() {
		cuLists = await meta<CuNamed[]>('clickup', 'lists', {
			folderId: cuFolderId || undefined,
			spaceId: cuFolderId ? undefined : cuSpaceId
		});
		cuListId = '';
		cuStatuses = [];
		cuSelected = [];
	}

	function loadStatuses() {
		if (!cuListId) {
			cuStatuses = [];
			cuSelected = [];
			return;
		}
		run(async () => {
			cuStatuses = await meta<CuStatus[]>('clickup', 'statuses', { listId: cuListId });
			cuSelected = cuStatuses
				.filter((s) => /^(to do|up next)$/i.test(s.status))
				.map((s) => s.status);
		});
	}

	function toggle(list: string[], value: string): string[] {
		return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
	}

	async function addSource(body: Record<string, unknown>) {
		const res = await fetch('/api/projects/sources', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ projectPath: project.path, ...body })
		});
		if (!res.ok) throw new Error((await res.json()).message ?? 'failed to add source');
		resetAdd();
		onchanged();
	}

	function submitGithub() {
		run(() => addSource({ type: 'github', owner: ghOwner.trim(), repo: ghRepo.trim() }));
	}
	function submitLinear() {
		run(() =>
			addSource({
				type: 'linear',
				apiKey,
				teamId: linTeamId,
				teamName: linTeamName,
				assigneeEmail: meId,
				stateIds: linStateIds
			})
		);
	}
	function submitClickup() {
		run(() =>
			addSource({
				type: 'clickup',
				apiKey,
				teamId: cuTeamId,
				teamName: cuTeamName,
				spaceId: cuSpaceId,
				spaceName: cuSpaceName,
				folderId: cuFolderId || undefined,
				folderName: cuFolderId ? cuFolderName : undefined,
				listId: cuListId,
				listName: cuListName,
				statuses: cuSelected,
				assigneeUserId: meId
			})
		);
	}

	async function remove(s: IssueSource) {
		await run(async () => {
			const res = await fetch(
				`/api/projects/sources?project=${encodeURIComponent(project.path)}&id=${encodeURIComponent(s.id)}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) {
				throw new Error((await res.json().catch(() => ({})))?.message ?? 'failed to remove source');
			}
			onchanged();
		});
	}
</script>

<div class="mt-3">
	<div class="mb-1 text-xs font-medium opacity-60">Issue sources</div>

	{#if errorMsg}
		<div class="alert alert-error mb-2 py-1 text-xs">{errorMsg}</div>
	{/if}

	{#if project.sources?.length}
		<div class="mb-2 space-y-1">
			{#each project.sources as s (s.id)}
				<div class="flex items-center gap-2 rounded-box border border-base-300 px-2 py-1 text-sm">
					<span class="badge badge-sm {ISSUE_BADGE[s.type].cls}">{ISSUE_BADGE[s.type].label}</span>
					<span class="min-w-0 flex-1 truncate">{summary(s)}</span>
					<button class="btn btn-ghost btn-xs" onclick={() => remove(s)} aria-label="Remove source">
						<Trash2 size={13} />
					</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if !addType}
		<div class="flex flex-wrap gap-1">
			<span class="text-xs opacity-50">Add:</span>
			<button class="btn btn-ghost btn-xs" onclick={() => (addType = 'github')}>
				<Plus size={12} /> GitHub
			</button>
			<button class="btn btn-ghost btn-xs" onclick={() => (addType = 'linear')}>
				<Plus size={12} /> Linear
			</button>
			<button class="btn btn-ghost btn-xs" onclick={() => (addType = 'clickup')}>
				<Plus size={12} /> ClickUp
			</button>
		</div>
	{:else}
		<div class="rounded-box border border-dashed border-base-300 p-3">
			<div class="mb-2 flex items-center gap-2">
				<span class="badge badge-sm {ISSUE_BADGE[addType].cls}">{ISSUE_BADGE[addType].label}</span>
				<span class="text-sm font-medium">Add {addType} source</span>
				<div class="flex-1"></div>
				<button class="btn btn-ghost btn-xs" onclick={resetAdd} aria-label="Cancel"><X size={14} /></button>
			</div>

			{#if addType === 'github'}
				<div class="flex flex-col gap-2 sm:flex-row">
					<input class="input input-sm flex-1" placeholder="owner" bind:value={ghOwner} />
					<input class="input input-sm flex-1" placeholder="repo" bind:value={ghRepo} />
				</div>
				<p class="mt-1 text-xs opacity-50">Lists open issues assigned to you (via gh). No API key.</p>
				<div class="mt-2 flex justify-end">
					<button class="btn btn-sm btn-primary" disabled={busy || !ghOwner.trim() || !ghRepo.trim()} onclick={submitGithub}>
						Add
					</button>
				</div>
			{:else if addType === 'linear'}
				{#if !connected}
					<input class="input input-sm w-full" type="password" placeholder="Linear API key" bind:value={apiKey} />
					<div class="mt-2 flex justify-end">
						<button class="btn btn-sm" disabled={busy || !apiKey.trim()} onclick={connectLinear}>Connect</button>
					</div>
				{:else}
					<p class="mb-2 text-xs opacity-60">Assignee: {meLabel}</p>
					<select class="select select-sm w-full" bind:value={linTeamId} onchange={loadLinearStates}>
						<option value="">pick a team…</option>
						{#each linTeams as t (t.id)}
							<option value={t.id}>{t.name} ({t.key})</option>
						{/each}
					</select>
					{#if linStates.length}
						<div class="mt-2 text-xs opacity-60">States to list:</div>
						<div class="mt-1 grid grid-cols-2 gap-1">
							{#each linStates as st (st.id)}
								<label class="label cursor-pointer justify-start gap-2 py-0.5">
									<input
										type="checkbox"
										class="checkbox checkbox-xs"
										checked={linStateIds.includes(st.id)}
										onchange={() => (linStateIds = toggle(linStateIds, st.id))}
									/>
									<span class="text-sm">{st.name}</span>
								</label>
							{/each}
						</div>
					{/if}
					<div class="mt-2 flex justify-end">
						<button class="btn btn-sm btn-primary" disabled={busy || !linTeamId || !linStateIds.length} onclick={submitLinear}>
							Add
						</button>
					</div>
				{/if}
			{:else if addType === 'clickup'}
				{#if !connected}
					<input class="input input-sm w-full" type="password" placeholder="ClickUp API key" bind:value={apiKey} />
					<div class="mt-2 flex justify-end">
						<button class="btn btn-sm" disabled={busy || !apiKey.trim()} onclick={connectClickup}>Connect</button>
					</div>
				{:else}
					<p class="mb-2 text-xs opacity-60">Assignee: {meLabel}</p>
					<div class="space-y-2">
						<select class="select select-sm w-full" bind:value={cuTeamId} onchange={loadSpaces}>
							<option value="">pick a workspace…</option>
							{#each cuTeams as t (t.id)}
								<option value={t.id}>{t.name}</option>
							{/each}
						</select>
						{#if cuSpaces.length}
							<select class="select select-sm w-full" bind:value={cuSpaceId} onchange={loadFoldersAndLists}>
								<option value="">pick a space…</option>
								{#each cuSpaces as s (s.id)}
									<option value={s.id}>{s.name}</option>
								{/each}
							</select>
						{/if}
						{#if cuSpaceId && cuFolders.length}
							<select class="select select-sm w-full" bind:value={cuFolderId} onchange={() => run(loadListsInner)}>
								<option value="">(no folder — lists in the space)</option>
								{#each cuFolders as f (f.id)}
									<option value={f.id}>{f.name}</option>
								{/each}
							</select>
						{/if}
						{#if cuSpaceId && cuLists.length}
							<select class="select select-sm w-full" bind:value={cuListId} onchange={loadStatuses}>
								<option value="">pick a list…</option>
								{#each cuLists as l (l.id)}
									<option value={l.id}>{l.name}</option>
								{/each}
							</select>
						{/if}
						{#if cuStatuses.length}
							<div class="text-xs opacity-60">Statuses to list:</div>
							<div class="grid grid-cols-2 gap-1">
								{#each cuStatuses as st (st.status)}
									<label class="label cursor-pointer justify-start gap-2 py-0.5">
										<input
											type="checkbox"
											class="checkbox checkbox-xs"
											checked={cuSelected.includes(st.status)}
											onchange={() => (cuSelected = toggle(cuSelected, st.status))}
										/>
										<span class="text-sm">{st.status}</span>
									</label>
								{/each}
							</div>
						{/if}
					</div>
					<div class="mt-2 flex justify-end">
						<button class="btn btn-sm btn-primary" disabled={busy || !cuListId || !cuSelected.length} onclick={submitClickup}>
							Add
						</button>
					</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>
