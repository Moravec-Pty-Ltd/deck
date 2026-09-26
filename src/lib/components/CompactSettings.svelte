<script lang="ts">
	import { Check, Shrink } from '@lucide/svelte';
	import { fetchSettings, patchSettings } from '$lib/settings-patch';
	import {
		COMPACT_PERCENT_MAX,
		COMPACT_PERCENT_MIN,
		DEFAULT_COMPACT_PERCENT,
		clampCompactPercent
	} from '$lib/context-core';

	// App-wide panel: when deck compacts a claude session on its own. Off by
	// default, because compacting is lossy and you may want to choose the moment
	// yourself (the Compact button on a session does the same thing on demand).
	let enabled = $state(false);
	let percent = $state(DEFAULT_COMPACT_PERCENT);
	let loaded = $state(false);
	let busy = $state(false);
	let saved = $state(false);
	let message = $state('');

	async function load() {
		try {
			const settings = await fetchSettings();
			enabled = settings.autoCompact?.enabled === true;
			percent = clampCompactPercent(settings.autoCompact?.percent);
			loaded = true;
		} catch (e) {
			message = e instanceof Error ? e.message : 'failed to load compaction settings';
		}
	}

	$effect(() => {
		void load();
	});

	async function save() {
		busy = true;
		message = '';
		saved = false;
		try {
			await patchSettings('autoCompact', { enabled, percent: clampCompactPercent(percent) });
			saved = true;
			await load();
		} catch (e) {
			message = e instanceof Error ? e.message : 'save failed';
		} finally {
			busy = false;
		}
	}
</script>

<div class="card border border-base-300 bg-base-100">
	<div class="card-body gap-3 p-4">
		<h2 class="m-0 flex items-center gap-2 text-base font-semibold">
			<Shrink size={16} /> Auto-compact
			{#if loaded && enabled}
				<span class="badge badge-ghost badge-sm">at {percent}%</span>
			{/if}
		</h2>
		<p class="m-0 text-xs opacity-70">
			Claude compacts a full context window on its own, but only once it is genuinely full, and that
			costs the best part of a minute at the end of a turn you were waiting on. Turn this on and deck
			compacts earlier, at a point you pick. What it keeps is what a handoff keeps: the goal, what is
			done and in progress, next steps, blockers, key files, decisions, and the git state. Claude
			sessions only.
		</p>
		{#if loaded}
			<label class="flex cursor-pointer items-center gap-2 text-sm">
				<input type="checkbox" class="toggle toggle-sm" bind:checked={enabled} />
				<span>Compact a session before its window fills</span>
			</label>
			<label class="form-control max-w-xs">
				<span class="label-text text-xs opacity-70">
					Compact at {percent}% full ({COMPACT_PERCENT_MIN} to {COMPACT_PERCENT_MAX})
				</span>
				<input
					type="range"
					class="range range-sm"
					min={COMPACT_PERCENT_MIN}
					max={COMPACT_PERCENT_MAX}
					step="5"
					disabled={!enabled}
					bind:value={percent}
				/>
			</label>
			<div class="flex items-center gap-2">
				<button class="btn btn-primary btn-sm" onclick={save} disabled={busy}>
					{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
					Save
				</button>
				{#if saved}
					<span class="flex items-center gap-1 text-xs text-success"><Check size={14} /> Saved</span>
				{/if}
				{#if message}
					<span class="text-xs text-error">{message}</span>
				{/if}
			</div>
		{/if}
	</div>
</div>
