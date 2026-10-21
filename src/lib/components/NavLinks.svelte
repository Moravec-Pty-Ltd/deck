<script lang="ts">
	// The app's destinations in one of three shapes: header tabs on wider
	// screens, a bottom bar on phones, and a menu list for the phone session
	// page, whose composer owns the bottom of the screen.
	import { Layers, Inbox, Workflow, Clock, Folders, Settings } from '@lucide/svelte';
	import { page } from '$app/state';
	import { NAV_ITEMS, badgeText, isCurrent, navLabel, type NavId } from '$lib/nav-core';

	let {
		variant,
		inboxCount = 0,
		onnavigate
	}: { variant: 'tabs' | 'bar' | 'menu'; inboxCount?: number; onnavigate?: () => void } = $props();

	const icons: Record<NavId, typeof Layers> = {
		sessions: Layers,
		inbox: Inbox,
		runs: Workflow,
		schedules: Clock,
		projects: Folders,
		settings: Settings
	};

	const items = $derived(
		NAV_ITEMS.map((item) => ({
			...item,
			icon: icons[item.id],
			current: isCurrent(item, page.url.pathname),
			badge: item.id === 'inbox' ? badgeText(inboxCount) : '',
			label: navLabel(item, item.id === 'inbox' ? inboxCount : 0),
			text: item.label
		}))
	);
</script>

{#if variant === 'menu'}
	<ul class="menu w-full p-0">
		{#each items as item (item.id)}
			<li>
				<a
					href={item.href}
					aria-current={item.current ? 'page' : undefined}
					aria-label={item.label}
					class={item.current ? 'menu-active' : ''}
					onclick={onnavigate}
				>
					<item.icon size={16} />
					<span class="flex-1">{item.text}</span>
					{#if item.badge}<span class="nav-badge">{item.badge}</span>{/if}
				</a>
			</li>
		{/each}
	</ul>
{:else}
	<nav aria-label="Primary" class="deck-nav deck-nav-{variant}">
		{#each items as item (item.id)}
			<a
				href={item.href}
				class="deck-nav-item"
				aria-current={item.current ? 'page' : undefined}
				aria-label={item.label}
				title={variant === 'tabs' ? item.text : undefined}
			>
				<span class="deck-nav-icon">
					<item.icon size={variant === 'bar' ? 20 : 16} />
					{#if item.badge && variant === 'bar'}<span class="nav-badge">{item.badge}</span>{/if}
				</span>
				<span class="deck-nav-label">{item.text}</span>
				{#if item.badge && variant === 'tabs'}<span class="nav-badge">{item.badge}</span>{/if}
			</a>
		{/each}
	</nav>
{/if}
