<script lang="ts">
	import type { PageProps } from './$types';
	import type { DeckSession, NewSessionPreset, Project } from '$lib/types';
	import ClaudeView from '$lib/components/ClaudeView.svelte';
	import ShellView from '$lib/components/ShellView.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import NewSessionModal from '$lib/components/NewSessionModal.svelte';
	import { shortPath } from '$lib/time';
	import { ArrowLeft, Bot, Terminal, Menu, X, Plus } from '@lucide/svelte';

	let { data }: PageProps = $props();
	const session = $derived(data.session);

	let projects = $state<Project[]>([]);
	let sessions = $state<DeckSession[]>([]);
	let modalOpen = $state(false);
	let preset = $state<NewSessionPreset | null>(null);
	let sidebarOpen = $state(false);

	async function refresh() {
		const [pRes, sRes] = await Promise.all([fetch('/api/projects'), fetch('/api/sessions')]);
		if (pRes.ok) projects = await pRes.json();
		if (sRes.ok) sessions = await sRes.json();
	}

	$effect(() => {
		refresh();
		const interval = setInterval(refresh, 5000);
		return () => clearInterval(interval);
	});

	function openNew() {
		preset = null;
		modalOpen = true;
	}
	function quickAdd(path: string) {
		preset = { projectPath: path };
		modalOpen = true;
		sidebarOpen = false;
	}
	function shellHere(s: DeckSession) {
		preset = { kind: 'shell', cwd: s.cwd, title: '' };
		modalOpen = true;
		sidebarOpen = false;
	}
</script>

<svelte:head>
	<title>{session.title} · deck</title>
</svelte:head>

{#snippet sidebar()}
	<Sidebar
		{projects}
		{sessions}
		currentId={session.id}
		onQuickAdd={quickAdd}
		onShellHere={shellHere}
	/>
{/snippet}

<div class="flex h-full lg:gap-5">
	<aside class="hidden h-full overflow-y-auto lg:block lg:w-56 lg:shrink-0">
		{@render sidebar()}
	</aside>

	<div class="flex h-full min-w-0 flex-1 flex-col">
		<div class="mb-2 flex items-center gap-2">
			<a href="/" class="btn btn-ghost btn-sm shrink-0" aria-label="Back">
				<ArrowLeft size={16} />
			</a>
			<button
				class="btn btn-ghost btn-sm shrink-0 lg:hidden"
				onclick={() => (sidebarOpen = true)}
				aria-label="Open sessions"
			>
				<Menu size={16} />
			</button>
			{#if session.kind === 'claude'}
				<Bot size={16} class="shrink-0 opacity-70" />
			{:else}
				<Terminal size={16} class="shrink-0 opacity-70" />
			{/if}
			<div class="flex min-w-0 flex-1 items-baseline gap-2">
				<span class="truncate font-medium">{session.title}</span>
				<span class="hidden truncate text-xs opacity-60 sm:inline">{shortPath(session.cwd)}</span>
			</div>
			{#if session.kind === 'claude' && session.permissionMode === 'bypassPermissions'}
				<span class="badge badge-outline badge-sm shrink-0">yolo</span>
			{/if}
			<button class="btn btn-primary btn-sm shrink-0" onclick={openNew} aria-label="New session">
				<Plus size={16} /> <span class="hidden sm:inline">New</span>
			</button>
		</div>

		<div class="min-h-0 flex-1">
			{#if session.kind === 'claude'}
				<ClaudeView {session} />
			{:else}
				<ShellView {session} />
			{/if}
		</div>
	</div>
</div>

{#if sidebarOpen}
	<div class="fixed inset-0 z-40 lg:hidden">
		<button
			class="absolute inset-0 bg-black/40"
			onclick={() => (sidebarOpen = false)}
			aria-label="Close sessions"
		></button>
		<div class="absolute inset-y-0 left-0 w-72 max-w-[80%] overflow-y-auto bg-base-100 p-3 shadow-xl">
			<div class="mb-2 flex justify-end">
				<button class="btn btn-ghost btn-sm" onclick={() => (sidebarOpen = false)} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			{@render sidebar()}
		</div>
	</div>
{/if}

<NewSessionModal bind:open={modalOpen} {preset} />
