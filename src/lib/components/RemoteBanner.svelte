<script lang="ts">
	import type { DeckSession } from '$lib/types';
	import { REMOTE_AGENT_OFF_NOTE, REMOTE_OFF_NOTE, REMOTE_SETUP_PROMPT } from '$lib/remote-core';
	import type { AgentDetection } from '$lib/agent-protocol';
	import { agentPost, sessionPath } from '$lib/agent-api';
	import { Server } from '@lucide/svelte';

	let { session, canSetup }: { session: DeckSession; canSetup: boolean } = $props();
	let busy = $state(false);
	let error = $state('');
	let installing = $state(false);
	let installed = $state('');
	const mode = $derived(session.remote?.mode);

	async function install() {
		installing = true;
		error = '';
		installed = '';
		try {
			const found = await agentPost<AgentDetection>('/api/agent/projects/remote/agent', { path: session.cwd });
			installed =
				found.mode === 'agent'
					? 'Installed. The deck agent takes over the next time claude starts here.'
					: (found.note ?? 'Installed, but the host still does not run it.');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not install';
		} finally {
			installing = false;
		}
	}

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
			<span class="min-w-0 flex-1 basis-56 truncate">
				Runs on <span class="font-mono">{session.remote.target}</span> in
				<span class="font-mono">{session.remote.path}</span>
			</span>
			{#if mode}
				<span class="badge badge-ghost badge-sm" title={mode === 'agent' ? 'Turns survive a dropped connection; questions and watches work' : 'Plain ssh: a dropped connection stops the turn'}>
					{mode === 'agent' ? 'deck agent' : 'bare SSH'}
				</span>
			{/if}
			{#if mode === 'bare'}
				<button class="btn btn-xs" disabled={installing} onclick={install}>
					{session.remote.agentNote ? 'Update deck agent' : 'Install deck agent'}
				</button>
			{/if}
			{#if canSetup}
				<button class="btn btn-xs" disabled={busy} onclick={setup}>Set up remote</button>
			{/if}
		</div>
		<p class="mt-1 opacity-60">{mode === 'agent' ? REMOTE_AGENT_OFF_NOTE : REMOTE_OFF_NOTE}</p>
		{#if session.remote.agentNote && !installed}<p class="mt-1 text-warning">{session.remote.agentNote}</p>{/if}
		{#if installed}<p class="mt-1" role="status">{installed}</p>{/if}
		{#if session.remote.worktreeError}
			<p class="mt-1 text-warning">
				Not isolated: the worktree could not be created ({session.remote.worktreeError}), so this session works in the checkout itself.
			</p>
		{/if}
		{#if error}<p class="mt-1 text-error" role="alert">{error}</p>{/if}
	</div>
{/if}
