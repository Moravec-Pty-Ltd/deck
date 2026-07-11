<script lang="ts">
	import type { SkillStatus } from '$lib/types';
	import { Check, Download, RefreshCw } from '@lucide/svelte';

	// App-wide panel: the shipped deck skill's install/version status per
	// harness, with a one-click install/update into that harness's skill dir.

	let statuses = $state<SkillStatus[]>([]);
	let loaded = $state(false);
	let busy = $state<string | null>(null);
	let errorMsg = $state('');

	async function load() {
		try {
			const res = await fetch('/api/skills');
			if (res.ok) statuses = await res.json();
			else errorMsg = 'failed to load skill status';
		} catch {
			errorMsg = 'failed to load skill status';
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		load();
	});

	async function install(kind: string) {
		errorMsg = '';
		busy = kind;
		try {
			const res = await fetch('/api/skills', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind })
			});
			if (!res.ok) {
				// A non-JSON failure (proxy error page, crash) must still surface a message.
				const err = await res.json().catch(() => null);
				errorMsg = err?.message ?? 'failed to install';
				return;
			}
			const updated: SkillStatus = await res.json();
			statuses = statuses.map((s) => (s.kind === updated.kind ? updated : s));
		} finally {
			busy = null;
		}
	}
</script>

<div class="rounded-box border border-base-300 bg-base-100 p-4">
	<h2 class="mb-1 text-sm font-semibold">Agent skills</h2>
	<p class="mb-3 text-xs opacity-60">
		Teach each installed harness to drive deck (the shipped
		<span class="font-mono">deck</span> skill, backed by
		<a href="/llms.txt" target="_blank" class="link">/llms.txt</a>).
	</p>
	{#if errorMsg}
		<div class="alert alert-error mb-3 py-2 text-sm">{errorMsg}</div>
	{/if}
	{#if !loaded}
		<p class="py-2 text-center text-sm opacity-60">Loading...</p>
	{:else}
		<div class="space-y-2">
			{#each statuses as s (s.kind)}
				<div class="flex items-center gap-2 text-sm">
					<span class="w-24 font-mono">{s.kind}</span>
					{#if !s.available}
						<span class="text-xs opacity-40">not installed on this machine</span>
					{:else if !s.supported}
						<span class="text-xs opacity-40">no known skill directory</span>
					{:else if s.upToDate}
						<span class="flex items-center gap-1 text-xs text-success">
							<Check size={13} /> v{s.installedVersion} installed
						</span>
					{:else if s.installed}
						<span class="text-xs opacity-60">
							v{s.installedVersion ?? '?'} installed, v{s.shippedVersion} available
						</span>
					{:else}
						<span class="text-xs opacity-60">skill not installed</span>
					{/if}
					<div class="flex-1"></div>
					{#if s.available && s.supported && !s.upToDate}
						<button
							class="btn btn-xs"
							disabled={busy === s.kind}
							onclick={() => install(s.kind)}
						>
							{#if s.installed}
								<RefreshCw size={12} /> Update
							{:else}
								<Download size={12} /> Install
							{/if}
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
