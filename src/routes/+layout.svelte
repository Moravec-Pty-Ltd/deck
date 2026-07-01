<script lang="ts">
	import './layout.css';
	import { Sun, Moon, BookOpen, Download, Bell, BellRing, BellOff, RefreshCw, X } from '@lucide/svelte';
	import { urlBase64ToUint8Array } from '$lib/push';
	import { watchForUpdate } from '$lib/pwa-update';
	import { page } from '$app/state';
	import CommandPalette from '$lib/components/CommandPalette.svelte';

	let { children } = $props();

	let paletteOpen = $state(false);

	function isEditable(el: EventTarget | null): boolean {
		const node = el as HTMLElement | null;
		if (!node || typeof node.tagName !== 'string') return false;
		const tag = node.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
	}

	// Cmd+K (Ctrl+K elsewhere) toggles the palette from any page. Leave Ctrl+K to
	// editable controls (it's kill-line in macOS text fields and readline, so the
	// chat/terminal inputs keep it) and never override a handler that already
	// claimed the event; Cmd+K carries no text-edit meaning, so it still opens the
	// palette even from an input.
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key !== 'k' && e.key !== 'K') return;
		if (!e.metaKey && !e.ctrlKey) return;
		if (e.defaultPrevented) return;
		if (!e.metaKey && isEditable(e.target)) return;
		e.preventDefault();
		paletteOpen = !paletteOpen;
	}

	// The session view (/s/[id]) runs its own full-height, edge-to-edge layout
	// (sidebar + panel flush under the header); every other route wants the body
	// padding, so scope it here rather than stripping it from every page.
	const bodyPadding = $derived(page.url.pathname.startsWith('/s/') ? '' : 'p-3 sm:p-4');

	let updateReady = $state(false);
	let refreshing = false;

	// Surface a non-blocking prompt when a newer service worker is installed; the
	// reload is what swaps the content-hashed app. Never reload out from under work.
	$effect(() => watchForUpdate(() => (updateReady = true)));

	function reloadForUpdate() {
		if (refreshing) return; // controllerchange can also fire; reload at most once
		refreshing = true;
		location.reload();
	}

	let theme = $state('dark');
	let installPrompt = $state<{ prompt: () => void; userChoice: Promise<unknown> } | null>(null);

	let pushSupported = $state(false);
	let pushPermission = $state<NotificationPermission>('default');
	let subscribed = $state(false);
	let pushBusy = $state(false);

	$effect(() => {
		pushSupported =
			'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
		if (!pushSupported) return;
		pushPermission = Notification.permission;
		navigator.serviceWorker.ready
			.then((reg) => reg.pushManager.getSubscription())
			.then((sub) => (subscribed = !!sub))
			.catch(() => {});
	});

	async function togglePush() {
		if (pushBusy) return;
		pushBusy = true;
		try {
			const reg = await navigator.serviceWorker.ready;
			if (subscribed) {
				const sub = await reg.pushManager.getSubscription();
				if (sub) {
					await fetch('/api/push/unsubscribe', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ endpoint: sub.endpoint })
					});
					await sub.unsubscribe();
				}
				subscribed = false;
				return;
			}
			const perm = await Notification.requestPermission();
			pushPermission = perm;
			if (perm !== 'granted') return;
			const { publicKey } = await (await fetch('/api/push/key')).json();
			const sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource
			});
			await fetch('/api/push/subscribe', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(sub)
			});
			subscribed = true;
		} finally {
			pushBusy = false;
		}
	}

	$effect(() => {
		theme = document.documentElement.dataset.theme || 'dark';
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

	// Browser UI bar colour per theme, matching each theme's header (base-100).
	const themeColor: Record<string, string> = {
		light: '#fbfcfd',
		dark: '#1a1f24',
		eink: '#ffffff'
	};

	function setTheme(next: string) {
		theme = next;
		document.documentElement.dataset.theme = next;
		localStorage.setItem('deck-theme', next);
		const m = document.querySelector('meta[name="theme-color"]');
		if (m) m.setAttribute('content', themeColor[next] ?? themeColor.dark);
	}

	const themes = [
		{ id: 'dark', label: 'Dark', icon: Moon },
		{ id: 'light', label: 'Light', icon: Sun },
		{ id: 'eink', label: 'E-ink', icon: BookOpen }
	];

	// Advance to the next theme in the header order, for the palette's Switch theme.
	function cycleTheme() {
		const order = themes.map((t) => t.id);
		setTheme(order[(order.indexOf(theme) + 1) % order.length]);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<svelte:head>
	<title>deck</title>
</svelte:head>

<CommandPalette
	bind:open={paletteOpen}
	{cycleTheme}
	notificationsSupported={pushSupported}
	toggleNotifications={togglePush}
/>

<div class="flex h-[100dvh] flex-col overflow-hidden bg-base-200">
	<header class="navbar min-h-12 shrink-0 gap-2 border-b border-base-300 bg-base-100 px-3 sm:px-4">
		<div class="flex flex-1 items-center">
			<a href="/" class="deck-brand flex items-center gap-2.5" aria-label="deck home">
				<span class="deck-mark" aria-hidden="true"></span>
				<span class="text-base font-semibold tracking-tight">deck</span>
			</a>
		</div>

		<div class="flex items-center gap-1.5">
			{#if installPrompt}
				<button class="btn btn-primary btn-sm" onclick={install} aria-label="Install app">
					<Download size={16} /> <span class="hidden sm:inline">Install</span>
				</button>
			{/if}
			{#if pushSupported}
				<button
					class="btn btn-square btn-ghost btn-sm"
					onclick={togglePush}
					disabled={pushBusy || pushPermission === 'denied'}
					title={pushPermission === 'denied'
						? 'Notifications blocked in browser settings'
						: subscribed
							? 'Notifications on'
							: 'Enable notifications'}
					aria-label="Toggle notifications"
				>
					{#if pushPermission === 'denied'}
						<BellOff size={16} />
					{:else if subscribed}
						<BellRing size={16} />
					{:else}
						<Bell size={16} />
					{/if}
				</button>
			{/if}
			<div class="join" role="group" aria-label="Theme">
				{#each themes as t (t.id)}
					<button
						class="btn join-item btn-sm {theme === t.id ? 'btn-active' : 'btn-ghost'}"
						onclick={() => setTheme(t.id)}
						title={t.label}
						aria-label={t.label}
						aria-pressed={theme === t.id}
					>
						<t.icon size={16} />
						<span class="hidden sm:inline">{t.label}</span>
					</button>
				{/each}
			</div>
		</div>
	</header>

	<main class="w-full min-h-0 flex-1 overflow-y-auto {bodyPadding}">
		{@render children()}
	</main>
</div>

{#if updateReady}
	<div
		class="fixed inset-x-0 bottom-4 z-50 flex justify-center px-3"
		role="status"
		aria-live="polite"
	>
		<div class="alert w-auto max-w-sm gap-3 border border-base-300 bg-base-100 shadow-lg">
			<RefreshCw size={16} class="shrink-0" />
			<span class="text-sm">A new version of deck is available.</span>
			<div class="flex items-center gap-1">
				<button class="btn btn-primary btn-sm" onclick={reloadForUpdate}>Reload</button>
				<button
					class="btn btn-square btn-ghost btn-sm"
					onclick={() => (updateReady = false)}
					aria-label="Dismiss"
				>
					<X size={16} />
				</button>
			</div>
		</div>
	</div>
{/if}
