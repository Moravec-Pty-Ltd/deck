<script lang="ts">
	import { onMount } from 'svelte';
	import { RefreshCw, Trash2 } from '@lucide/svelte';
	import { confirmAction } from '$lib/confirm.svelte';
	import { SHARED_PARTS, type ClaudeAccountKind, type ClaudeAccountView, type SharedPart } from '$lib/types';

	let accounts = $state<ClaudeAccountView[]>([]);
	let loaded = $state(false);
	let busy = $state(false);
	let message = $state('');
	let name = $state('');
	let kind = $state<ClaudeAccountKind>('login');
	let apiKey = $state('');
	// Per account: a replacement API key being typed.
	let keys = $state<Record<string, string>>({});

	async function load() {
		try {
			const res = await fetch('/api/agent/accounts');
			if (!res.ok) throw new Error("Couldn't load accounts");
			accounts = await res.json();
			loaded = true;
		} catch (e) {
			message = e instanceof Error ? e.message : "Couldn't load accounts";
		}
	}

	onMount(() => {
		void load();
	});

	async function post(body: Record<string, unknown>): Promise<boolean> {
		busy = true;
		message = '';
		try {
			const res = await fetch('/api/agent/accounts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error((await res.json()).message ?? 'Save failed');
			await load();
			return true;
		} catch (e) {
			message = e instanceof Error ? e.message : 'Save failed';
			return false;
		} finally {
			busy = false;
		}
	}

	async function add() {
		if (await post({ name: name.trim(), kind, ...(kind === 'api' && { apiKey }) })) {
			name = '';
			apiKey = '';
		}
	}

	function toggleShare(a: ClaudeAccountView, part: SharedPart, on: boolean) {
		void post({ name: a.name, share: on ? [...a.share, part] : a.share.filter((p) => p !== part) });
	}

	async function saveKey(a: ClaudeAccountView) {
		if (await post({ name: a.name, apiKey: keys[a.name] ?? '' })) keys[a.name] = '';
	}

	async function remove(a: ClaudeAccountView) {
		const ok = await confirmAction({
			title: `Remove account "${a.name}"?`,
			body: 'Projects and sessions using it will refuse to start until you pick another. Its config directory, with its login and history, stays on disk.',
			confirmLabel: 'Remove',
			danger: true
		});
		if (!ok) return;
		await fetch(`/api/agent/accounts?name=${encodeURIComponent(a.name)}`, { method: 'DELETE' });
		await load();
	}
</script>

<div class="card border border-base-300 bg-base-100">
	<div class="card-body gap-3 p-4">
		{#if loaded}
			<p class="m-0 text-xs opacity-70">
				Default is your own Claude login. Add another account here, then pick it per project. A
				session keeps the account it started with.
			</p>
			{#each accounts as a (a.name)}
				<div class="rounded-box border border-base-300 p-3">
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-medium">{a.name}</span>
						<span class="badge badge-sm badge-ghost">{a.kind === 'login' ? 'Login' : 'API'}</span>
						{#if a.ready}
							<span class="text-xs text-success">
								Ready{#if a.email}: {a.email}{/if}{#if a.org} ({a.org}){/if}
							</span>
						{:else}
							<span class="text-xs text-warning">{a.problem}</span>
						{/if}
						<div class="flex-1"></div>
						<button class="btn btn-ghost btn-xs" onclick={load} aria-label="Check again" title="Check again">
							<RefreshCw size={13} />
						</button>
						<button class="btn btn-ghost btn-xs" onclick={() => remove(a)} aria-label="Remove {a.name}">
							<Trash2 size={13} />
						</button>
					</div>
					{#if a.loginCommand && !a.ready}
						<p class="mt-2 mb-1 text-xs opacity-70">Log in once by running this in a terminal:</p>
						<code class="block overflow-x-auto rounded bg-base-200 px-2 py-1 text-xs select-all">{a.loginCommand}</code>
					{/if}
					{#if a.kind === 'api'}
						<div class="mt-2 flex items-center gap-2">
							<input
								class="input input-sm w-full max-w-xs font-mono"
								type="password"
								autocomplete="off"
								placeholder={a.ready ? 'Replace API key' : 'API key'}
								bind:value={keys[a.name]}
							/>
							<button class="btn btn-sm" onclick={() => saveKey(a)} disabled={busy || !keys[a.name]?.trim()}>Save key</button>
						</div>
						{#if a.envKeys.length}
							<p class="mt-1 mb-0 text-xs opacity-60">Settings from settings.json: {a.envKeys.join(', ')}</p>
						{/if}
					{/if}
					<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
						<span class="opacity-70">Share from your own config:</span>
						{#each SHARED_PARTS as part (part)}
							<label class="flex cursor-pointer items-center gap-1">
								<input
									type="checkbox"
									class="checkbox checkbox-xs"
									checked={a.share.includes(part)}
									disabled={busy}
									onchange={(e) => toggleShare(a, part, e.currentTarget.checked)}
								/>
								<span class="font-mono">{part}</span>
							</label>
						{/each}
					</div>
				</div>
			{/each}
			<div class="flex flex-wrap items-end gap-2">
				<label class="flex flex-col gap-1">
					<span class="label-text text-xs opacity-70">Name</span>
					<input class="input input-sm w-40" placeholder="acme" autocomplete="off" bind:value={name} />
				</label>
				<label class="flex flex-col gap-1">
					<span class="label-text text-xs opacity-70">Type</span>
					<select class="select select-sm" bind:value={kind}>
						<option value="login">Login (Team or Enterprise seat)</option>
						<option value="api">API key</option>
					</select>
				</label>
				{#if kind === 'api'}
					<label class="flex flex-col gap-1">
						<span class="label-text text-xs opacity-70">API key</span>
						<input class="input input-sm w-56 font-mono" type="password" autocomplete="off" bind:value={apiKey} />
					</label>
				{/if}
				<button class="btn btn-sm btn-primary" onclick={add} disabled={busy || !name.trim()}>Add account</button>
			</div>
		{/if}
		{#if message}
			<span class="text-xs text-error">{message}</span>
		{/if}
	</div>
</div>
