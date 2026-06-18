<script lang="ts">
	import './layout.css';
	import { LayoutGrid, Sun, Moon, BookOpen, Download, Bell, BellRing, BellOff } from '@lucide/svelte';
	import { urlBase64ToUint8Array } from '$lib/push';

	let { children } = $props();

	let theme = $state('light');
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
		{#if pushSupported}
			<button
				class="btn btn-ghost btn-sm mr-2"
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

	<main class="w-full min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
		{@render children()}
	</main>
</div>
