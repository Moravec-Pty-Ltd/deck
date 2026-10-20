<script lang="ts">
	// Keeps the nav's inbox badge current: how many asks and blocked runs wait,
	// recounted when the event feed reports a change that can touch the inbox.
	// Renders nothing; mounted only where the nav shows, so the sign-in pages
	// hold no feed open.
	import { sessionFeed } from '$lib/session-feed.svelte';
	import { touchesInbox, type InboxAsk } from '$lib/inbox-core';
	import { api } from '$lib/workflow-view';

	let { count = $bindable(0) }: { count?: number } = $props();

	let generation = 0;

	sessionFeed((res) => {
		if (touchesInbox(res)) void load();
	});

	async function load() {
		const n = ++generation;
		try {
			const asks = await api<InboxAsk[]>('/api/agent/asks');
			if (n === generation) count = asks.length;
		} catch {
			// Keep the last count: a failed read is not an empty inbox.
		}
	}
</script>
