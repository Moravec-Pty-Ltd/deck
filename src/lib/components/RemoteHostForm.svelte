<script lang="ts">
	import type { Project, RemoteAuth } from '$lib/types';
	import { parseProjectRemote } from '$lib/remote-core';
	import { createProjectSaver } from './project-form.svelte';
	import { Check, ChevronDown, Globe } from '@lucide/svelte';

	let { project, onchanged }: { project: Project; onchanged: () => void } = $props();

	type Kind = RemoteAuth['kind'];
	type Status = { secretSaved: boolean; hostKey: 'default' | 'trusted' | 'unknown' };

	let open = $state(false);
	let enabled = $state(false);
	let target = $state('');
	let path = $state('');
	let kind = $state<Kind>('default');
	let identityFile = $state('');
	let formError = $state('');

	const saver = createProjectSaver(() => {
		onchanged();
		void loadStatus();
	});

	// Secret and host key state belongs to the saved setting, not the form.
	const savedKind = $derived(project.remote?.auth.kind ?? 'default');
	const needsSecret = $derived(savedKind !== 'default');
	let status = $state<Status | null>(null);
	let secret = $state('');
	let secretReplacing = $state(false);
	let secretBusy = $state(false);
	let secretError = $state('');
	let keys = $state<{ type: string; fingerprint: string }[]>([]);
	let keyBusy = $state(false);
	let keyError = $state('');

	const q = () => `path=${encodeURIComponent(project.path)}`;

	async function message(res: Response, fallback: string): Promise<string> {
		return (await res.json().catch(() => ({})))?.message ?? fallback;
	}

	async function loadStatus() {
		if (!project.remote || !needsSecret) {
			status = null;
			return;
		}
		try {
			const res = await fetch(`/api/agent/projects/remote?${q()}`);
			if (res.ok) status = await res.json();
		} catch {
			// keep the previous status
		}
	}

	function toggle() {
		if (!open) {
			const r = project.remote;
			enabled = !!r;
			target = r?.target ?? '';
			path = r?.path ?? '';
			kind = r?.auth.kind ?? 'default';
			identityFile = r?.auth.kind === 'key' ? r.auth.identityFile : '';
			formError = '';
			void loadStatus();
		}
		open = !open;
	}

	function save() {
		formError = '';
		if (!enabled) {
			saver.save({ path: project.path, name: project.name, remote: null });
			return;
		}
		const auth = kind === 'key' ? { kind, identityFile } : { kind };
		try {
			const remote = parseProjectRemote({ target, path, auth }, undefined);
			saver.save({ path: project.path, name: project.name, remote });
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Invalid remote settings';
		}
	}

	async function putSecret() {
		secretBusy = true;
		secretError = '';
		try {
			const res = await fetch('/api/agent/projects/remote/secret', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: project.path, secret })
			});
			if (!res.ok) {
				secretError = await message(res, 'failed to save');
				return;
			}
			secret = '';
			secretReplacing = false;
			await loadStatus();
		} catch {
			secretError = 'failed to save';
		} finally {
			secretBusy = false;
		}
	}

	async function removeSecret() {
		secretBusy = true;
		secretError = '';
		try {
			const res = await fetch(`/api/agent/projects/remote/secret?${q()}`, { method: 'DELETE' });
			if (!res.ok) secretError = await message(res, 'failed to remove');
			await loadStatus();
		} catch {
			secretError = 'failed to remove';
		} finally {
			secretBusy = false;
		}
	}

	async function checkHostKey() {
		keyBusy = true;
		keyError = '';
		keys = [];
		try {
			const res = await fetch(`/api/agent/projects/remote/host-key?${q()}`);
			if (!res.ok) {
				keyError = await message(res, 'host key scan failed');
				return;
			}
			keys = (await res.json()).keys ?? [];
			if (!keys.length) keyError = 'The host returned no keys.';
		} catch {
			keyError = 'host key scan failed';
		} finally {
			keyBusy = false;
		}
	}

	async function acceptKeys() {
		keyBusy = true;
		keyError = '';
		try {
			const res = await fetch('/api/agent/projects/remote/host-key', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: project.path, fingerprints: keys.map((k) => k.fingerprint) })
			});
			if (!res.ok) {
				keyError = await message(res, 'could not accept');
				return;
			}
			keys = [];
			await loadStatus();
		} catch {
			keyError = 'could not accept';
		} finally {
			keyBusy = false;
		}
	}
</script>

<div class="mt-3">
	<button class="flex items-center gap-2 text-xs font-medium opacity-60" onclick={toggle}>
		<Globe size={13} />
		Remote host{#if project.remote}<span class="badge badge-ghost badge-xs">{project.remote.target}</span>{/if}
		<ChevronDown size={13} class={open ? '' : '-rotate-90'} />
	</button>

	{#if open}
		<div class="mt-2 space-y-3 rounded-box border border-dashed border-base-300 p-3">
			{#if saver.errorMsg || formError}
				<div class="alert alert-error py-1 text-xs">{formError || saver.errorMsg}</div>
			{/if}

			<label class="flex cursor-pointer items-center gap-2 text-sm">
				<input type="checkbox" class="toggle toggle-sm" bind:checked={enabled} />
				<span>Run this project's sessions on a remote host over SSH</span>
			</label>

			{#if enabled}
				<p class="text-[11px] opacity-50">
					The host needs sshd, <code class="font-mono">claude</code> on a non-interactive PATH, git and a POSIX shell. tmux is recommended.
				</p>
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-col gap-1 text-xs">
						<span class="font-medium opacity-70">Target</span>
						<input class="input input-sm w-56 font-mono" placeholder="user@host[:port]" bind:value={target} />
					</label>
					<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs">
						<span class="font-medium opacity-70">Path on host</span>
						<input class="input input-sm w-full font-mono" placeholder="/path/to/project" bind:value={path} />
					</label>
				</div>
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-col gap-1 text-xs">
						<span class="font-medium opacity-70">Authentication</span>
						<select class="select select-sm w-48" bind:value={kind}>
							<option value="default">Default ssh config</option>
							<option value="key">Key file</option>
							<option value="password">Password</option>
						</select>
					</label>
					{#if kind === 'key'}
						<label class="flex min-w-48 flex-1 flex-col gap-1 text-xs">
							<span class="font-medium opacity-70">Identity file (inside ~/.ssh on the deck host)</span>
							<input class="input input-sm w-full font-mono" placeholder="~/.ssh/id_ed25519" bind:value={identityFile} />
						</label>
					{/if}
				</div>
			{/if}

			<div class="flex items-center justify-end gap-2">
				{#if saver.saved}<span class="flex items-center gap-1 text-xs text-success"><Check size={13} /> Saved</span>{/if}
				<button class="btn btn-sm btn-primary" disabled={saver.busy} onclick={save}>Save remote host</button>
			</div>

			{#if project.remote && needsSecret}
				<div class="space-y-2 border-t border-base-300 pt-3">
					<div class="text-xs font-medium opacity-70">
						{savedKind === 'password' ? 'Password' : 'Key passphrase (optional)'}
					</div>
					{#if status?.secretSaved && !secretReplacing}
						<div class="flex items-center gap-2 text-sm">
							<span class="flex items-center gap-1 text-success"><Check size={13} /> Saved</span>
							<button class="btn btn-ghost btn-xs" onclick={() => (secretReplacing = true)}>Replace</button>
							<button class="btn btn-ghost btn-xs" disabled={secretBusy} onclick={removeSecret}>Remove</button>
						</div>
					{:else}
						<div class="flex items-center gap-2">
							<input
								type="password"
								class="input input-sm w-56"
								autocomplete="off"
								aria-label={savedKind === 'password' ? 'Password' : 'Key passphrase'}
								bind:value={secret}
							/>
							<button class="btn btn-sm" disabled={secretBusy || !secret} onclick={putSecret}>Save</button>
							{#if secretReplacing}
								<button class="btn btn-ghost btn-sm" onclick={() => { secretReplacing = false; secret = ''; }}>Cancel</button>
							{/if}
						</div>
					{/if}
					{#if secretError}<p class="text-xs text-error" role="alert">{secretError}</p>{/if}

					<div class="flex items-center gap-2 pt-1 text-sm">
						<span class="text-xs font-medium opacity-70">Host key</span>
						{#if status?.hostKey === 'trusted'}
							<span class="flex items-center gap-1 text-success"><Check size={13} /> Trusted</span>
						{:else}
							<span class="text-warning">Not accepted yet</span>
						{/if}
						<button class="btn btn-ghost btn-xs" disabled={keyBusy} onclick={checkHostKey}>Check host key</button>
					</div>
					{#if keys.length}
						<ul class="space-y-1 font-mono text-xs">
							{#each keys as k (k.fingerprint)}
								<li>{k.type} {k.fingerprint}</li>
							{/each}
						</ul>
						<button class="btn btn-sm" disabled={keyBusy} onclick={acceptKeys}>Accept</button>
					{/if}
					{#if keyError}<p class="text-xs text-error" role="alert">{keyError}</p>{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
