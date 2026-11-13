<script lang="ts">
	import type { DeckSession } from '$lib/types';
	import { REMOTE_OFF_NOTE, REMOTE_SETUP_PROMPT } from '$lib/remote-core';
	import { agentPost, sessionPath } from '$lib/agent-api';
	import { Server } from '@lucide/svelte';

	let { session, canSetup }: { session: DeckSession; canSetup: boolean } = $props();
	let busy = $state(false);
	let error = $state('');

	async function setup() {
		busy = true;
		error = '';
		try {
			await agentPost(sessionPath(session.id, 'message'), { text: REMOTE_SETUP_PROMPT });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not send';
		} finally {
			busy = false;
		}
	}
</script>

{#if session.remote}
	<div class="mb-2 shrink-0 rounded-box border border-base-300 bg-base-200/50 px-3 py-2 text-xs">
		<div class="flex flex-wrap items-center gap-2">
			<Server size={13} class="shrink-0 opacity-60" />
			<span class="min-w-0 flex-1 truncate">
				Runs on <span class="font-mono">{session.remote.target}</span> in
				<span class="font-mono">{session.remote.path}</span>
			</span>
			{#if canSetup}
				<button class="btn btn-xs" disabled={busy} onclick={setup}>Set up remote</button>
			{/if}
		</div>
		<p class="mt-1 opacity-60">{REMOTE_OFF_NOTE}</p>
		{#if session.remote.worktreeError}
			<p class="mt-1 text-warning">
				Not isolated: the worktree could not be created ({session.remote.worktreeError}), so this session works in the checkout itself.
			</p>
		{/if}
		{#if error}<p class="mt-1 text-error" role="alert">{error}</p>{/if}
	</div>
{/if}
