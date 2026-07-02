<script lang="ts">
	import { untrack } from 'svelte';
	import type { SessionKind } from '$lib/types';
	import { CLAUDE_MODELS, modelLabel, switchModel } from '$lib/models';
	import { dismissOnOutside } from '$lib/dismiss';
	import { Cpu, Check } from '@lucide/svelte';

	// Header chip showing the session's current model, opening a switcher (issue
	// #88). claude picks from the same shortnames as the New Session modal;
	// pi/codex take a free-text id. Disabled while a turn runs (the model applies
	// on the next turn, so switching mid-turn would only mislead); the server 409s
	// on that race anyway.
	let {
		id,
		kind,
		model,
		disabled = false,
		onChange
	}: {
		id: string;
		kind: SessionKind;
		model: string | undefined;
		disabled?: boolean;
		onChange: () => void;
	} = $props();

	let open = $state(false);
	let busy = $state(false);
	let err = $state('');
	let text = $state('');

	// Seed the free-text field on each open (untracked, so a background poll
	// can't clobber a half-typed id); clear a stale error on close.
	$effect(() => {
		if (open) text = untrack(() => model ?? '');
		else err = '';
	});

	async function switchTo(next: string) {
		if (busy) return;
		busy = true;
		err = '';
		try {
			await switchModel(id, next);
			open = false;
			onChange();
		} catch (e) {
			err = e instanceof Error ? e.message : 'model switch failed';
		} finally {
			busy = false;
		}
	}
</script>

{#if disabled}
	<span class="badge badge-outline badge-sm shrink-0 gap-1 opacity-50" title="Model switches apply between turns">
		<Cpu size={12} />
		<span class="hidden sm:inline">{modelLabel(model)}</span>
	</span>
{:else}
	<details class="dropdown dropdown-end shrink-0" bind:open use:dismissOnOutside={() => (open = false)}>
		<summary
			class="badge badge-outline badge-sm cursor-pointer list-none gap-1 [&::-webkit-details-marker]:hidden"
			title="Model: {modelLabel(model)} (click to change)"
		>
			<Cpu size={12} />
			<span class="hidden sm:inline">{modelLabel(model)}</span>
		</summary>
		<div
			class="dropdown-content z-20 mt-1 w-48 rounded-box border border-base-300 bg-base-100 p-2 text-sm shadow-lg"
		>
			{#if kind === 'claude'}
				<ul class="menu menu-sm w-full p-0">
					{#each ['', ...CLAUDE_MODELS] as m (m)}
						<li>
							<button onclick={() => switchTo(m)} disabled={busy}>
								{modelLabel(m)}
								{#if (model ?? '') === m}<Check size={14} class="ml-auto" />{/if}
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="flex flex-col gap-2">
					<input
						class="input input-sm w-full"
						placeholder="model id (empty for default)"
						bind:value={text}
						onkeydown={(e) => {
							if (e.key === 'Enter') switchTo(text);
						}}
					/>
					<button class="btn btn-primary btn-xs self-end" onclick={() => switchTo(text)} disabled={busy}>
						{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if} Apply
					</button>
				</div>
			{/if}
			{#if err}<p class="mt-1 px-1 text-xs text-error">{err}</p>{/if}
		</div>
	</details>
{/if}
