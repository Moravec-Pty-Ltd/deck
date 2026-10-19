<script lang="ts">
	import { tick } from 'svelte';
	import { SquareSlash } from '@lucide/svelte';
	import { agentGet, agentPath } from '$lib/agent-api';
	import { dismissOnOutside } from '$lib/dismiss';
	import { insertSkill, projectNameForCwd, rankSkills, slashQuery, type SkillInfo } from '$lib/skills-core';

	// The composer's skill list: global skills plus the session project's, opened
	// from the button or by typing "/" at the start of the message. Picking one
	// writes `/name ` into the composer and calls `onpick`, so the send can ask
	// the server to treat the message as a skill command. The panel sits above
	// the composer (the nearest positioned ancestor), not in a bottom drawer, so
	// on a phone it stays clear of the on-screen keyboard while typing "/".
	let {
		text = $bindable(''),
		cwd,
		textarea,
		onpick
	}: {
		text?: string;
		cwd: string;
		textarea?: HTMLTextAreaElement;
		onpick: () => void;
	} = $props();

	let catalogue = $state<SkillInfo[] | null>(null);
	let projects = $state<{ path: string; name: string }[]>([]);
	let loading = $state(false);
	let loadError = $state('');
	// Opened from the button: filtered by the panel's own search field.
	let browsing = $state(false);
	let search = $state('');
	// The composer text an Escape closed the "/" list on; it reopens once the text moves on.
	let dismissedAt = $state<string | null>(null);
	let active = $state(0);
	let searchInput = $state<HTMLInputElement>();
	let listEl = $state<HTMLElement>();

	const typed = $derived(slashQuery(text));
	const slashOpen = $derived(typed !== null && text !== dismissedAt);
	const open = $derived(browsing || slashOpen);
	const query = $derived(browsing ? search : (typed ?? ''));
	const project = $derived(projectNameForCwd(cwd, projects));
	const results = $derived(catalogue ? rankSkills(catalogue, query, project) : []);

	$effect(() => {
		if (open && catalogue === null) load();
	});

	$effect(() => {
		void query;
		active = 0;
	});

	async function load() {
		catalogue = [];
		loading = true;
		loadError = '';
		try {
			const [s, p] = await Promise.all([
				agentGet<{ skills: SkillInfo[] }>(agentPath('skills')),
				agentGet<{ path: string; name: string }[]>(agentPath('projects'))
			]);
			catalogue = s.skills;
			projects = p;
		} catch (e) {
			catalogue = null;
			loadError = e instanceof Error ? e.message : 'could not load skills';
		} finally {
			loading = false;
		}
	}

	async function toggle() {
		browsing = !browsing;
		if (!browsing) return;
		search = '';
		await tick();
		searchInput?.focus();
	}

	function close() {
		if (browsing) browsing = false;
		else dismissedAt = text;
	}

	async function pick(skill: SkillInfo) {
		text = insertSkill(text, skill.name);
		browsing = false;
		onpick();
		await tick();
		textarea?.focus();
		textarea?.setSelectionRange(text.length, text.length);
	}

	async function move(delta: number) {
		if (!results.length) return;
		active = (active + delta + results.length) % results.length;
		await tick();
		listEl?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	const KEYS: Record<string, () => void> = {
		ArrowDown: () => move(1),
		ArrowUp: () => move(-1),
		Escape: close,
		Enter: () => results[active] && pick(results[active]),
		Tab: () => results[active] && pick(results[active])
	};

	// Called from the composer's keydown (and the panel's search field). True when
	// the list consumed the key, so the composer skips its own handling.
	export function handleKey(e: KeyboardEvent): boolean {
		const action = KEYS[e.key];
		if (!open || !action || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
		if ((e.key === 'Enter' || e.key === 'Tab') && !results.length) return false;
		e.preventDefault();
		e.stopPropagation();
		action();
		return true;
	}
</script>

<div class="contents" use:dismissOnOutside={() => (browsing = false)}>
	<button
		class="btn btn-ghost btn-square {browsing ? 'btn-active' : ''}"
		onclick={toggle}
		aria-label="Skills"
		aria-expanded={open}
		title="Skills (or type / to start)"
	>
		<SquareSlash size={16} />
	</button>

	{#if open}
		<div
			class="absolute inset-x-2 bottom-full z-20 mb-1 rounded-box border border-base-300 bg-base-100 p-2 text-sm shadow-lg sm:inset-x-3 sm:left-auto sm:w-96"
		>
			{#if browsing}
				<input
					bind:this={searchInput}
					bind:value={search}
					class="input input-sm mb-2 w-full"
					placeholder="Filter skills"
					aria-label="Filter skills"
					aria-controls="skill-picker-list"
					aria-activedescendant={results.length ? `skill-option-${active}` : undefined}
					onkeydown={handleKey}
				/>
			{/if}
			{#if loadError}
				<p class="px-2 py-1 text-error">{loadError}</p>
			{:else if loading}
				<p class="px-2 py-1 opacity-60">Loading skills</p>
			{:else if !results.length}
				<p class="px-2 py-1 opacity-60">No skill matches "{query}"</p>
			{:else}
				<ul
					bind:this={listEl}
					id="skill-picker-list"
					class="menu menu-sm max-h-64 w-full flex-nowrap overflow-y-auto p-0"
					role="listbox"
					aria-label="Skills"
				>
					{#each results as skill, i (skill.name)}
						<li>
							<button
								id="skill-option-{i}"
								data-index={i}
								role="option"
								aria-selected={i === active}
								class="flex flex-col items-start gap-0.5 text-left {i === active ? 'menu-active' : ''}"
								onpointerdown={(e) => e.preventDefault()}
								onclick={() => pick(skill)}
								onpointerenter={() => (active = i)}
							>
								<span class="flex w-full items-center gap-2">
									<span class="truncate font-mono">/{skill.name}</span>
									{#if skill.scope !== 'global'}
										<span class="badge badge-ghost badge-xs ml-auto shrink-0">{skill.scope}</span>
									{/if}
								</span>
								{#if skill.description}
									<span class="line-clamp-2 text-xs opacity-60">{skill.description}</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
