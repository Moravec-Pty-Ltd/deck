<script lang="ts">
	import './layout.css';
	import { LayoutGrid, Sun, Moon, BookOpen, Download } from '@lucide/svelte';

	let { children } = $props();

	let theme = $state('light');
	let installPrompt = $state<{ prompt: () => void; userChoice: Promise<unknown> } | null>(null);

	$effect(() => {
		theme = document.documentElement.dataset.theme || 'light';
	});

	// Capture Chrome's install prompt so we can offer an in-app Install button
	// (the browser menu item is easy to miss, or hidden on some devices).
	$effect(() => {
		const onPrompt = (e: Event) => {
			e.preventDefault();
			installPrompt = e as unknown as { prompt: () => void; userChoice: Promise<unknown> };
		};
		const onInstalled = () => (installPrompt = null);
		window.addEventListener('beforeinstallprompt', onPrompt);
		window.addEventListener('appinstalled', onInstalled);
		return () => {
			window.removeEventListener('beforeinstallprompt', onPrompt);
			window.removeEventListener('appinstalled', onInstalled);
		};
	});

	async function install() {
		if (!installPrompt) return;
		installPrompt.prompt();
		await installPrompt.userChoice;
		installPrompt = null;
	}

	function setTheme(next: string) {
		theme = next;
		document.documentElement.dataset.theme = next;
		localStorage.setItem('deck-theme', next);
		const m = document.querySelector('meta[name="theme-color"]');
		if (m) m.setAttribute('content', next === 'dark' ? '#1d232a' : '#ffffff');
	}

	const themes = [
		{ id: 'light', label: 'Light', icon: Sun },
		{ id: 'dark', label: 'Dark', icon: Moon },
		{ id: 'eink', label: 'E-ink', icon: BookOpen }
	];
</script>

<svelte:head>
	<title>deck</title>
</svelte:head>

<div class="flex h-[100dvh] flex-col overflow-hidden bg-base-200">
	<header class="navbar min-h-12 shrink-0 border-b border-base-300 bg-base-100 px-3 sm:px-4">
		<div class="flex-1">
			<a href="/" class="flex items-center gap-2 text-lg font-semibold">
				<LayoutGrid size={20} />
				deck
			</a>
		</div>
		{#if installPrompt}
			<button class="btn btn-primary btn-sm mr-2" onclick={install} aria-label="Install app">
				<Download size={16} /> <span class="hidden sm:inline">Install</span>
			</button>
		{/if}
		<div class="join">
			{#each themes as t (t.id)}
				<button
					class="btn join-item btn-sm {theme === t.id ? 'btn-active' : 'btn-ghost'}"
					onclick={() => setTheme(t.id)}
					title={t.label}
					aria-label={t.label}
				>
					<t.icon size={16} />
					<span class="hidden sm:inline">{t.label}</span>
				</button>
			{/each}
		</div>
	</header>

	<main class="mx-auto w-full max-w-5xl min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
		{@render children()}
	</main>
</div>
