<script lang="ts">
	// The agent/model/effort pick for one automation lane (issue #223), shown under
	// its toggle on the Projects page. A blank claude model or effort falls back to
	// the project's remembered pick and then the CLI default. pi is the exception:
	// its provider and model are a pair, so naming either half opts the lane out of
	// the remembered pi pick entirely rather than mixing the two.
	import type { DeckSettings } from '$lib/types';
	import { AGENT_KINDS } from '$lib/types';
	import { forKind, type AgentRow } from '$lib/automation-form-core';
	import { claudeModelOptions } from '$lib/models';
	import { EFFORT_LEVELS } from '$lib/effort';

	let {
		agent = $bindable(),
		settings,
		lane
	}: { agent: AgentRow; settings: DeckSettings; lane: string } = $props();

	// A model this deck no longer offers (a profile deleted from ~/.deck settings)
	// still needs an option, or the select renders blank while the lane keeps
	// launching on it.
	const modelOptions = $derived.by(() => {
		const options = claudeModelOptions(settings);
		if (!agent.model || options.some((o) => o.value === agent.model)) return options;
		return [...options, { value: agent.model, label: `${agent.model} (not configured)` }];
	});

	// Switching kind drops the fields the new one has no use for, so a pi provider
	// or a claude effort can't linger and be rejected on save.
	function onKind() {
		agent = forKind(agent, agent.kind);
	}
</script>

<div class="mt-1 ml-8 flex flex-wrap items-center gap-2">
	<select
		class="select select-xs w-28"
		aria-label="{lane} agent"
		bind:value={agent.kind}
		onchange={onKind}
	>
		{#each AGENT_KINDS as k (k)}
			<option value={k}>{k}</option>
		{/each}
	</select>
	{#if agent.kind === 'claude'}
		<select class="select select-xs w-48" aria-label="{lane} model" bind:value={agent.model}>
			<option value="">remembered model</option>
			{#each modelOptions as m (m.value)}
				<option value={m.value}>{m.label}</option>
			{/each}
		</select>
		<select class="select select-xs w-36" aria-label="{lane} effort" bind:value={agent.effort}>
			<option value={undefined}>remembered effort</option>
			{#each EFFORT_LEVELS as e (e)}
				<option value={e}>{e}</option>
			{/each}
		</select>
	{:else}
		{#if agent.kind === 'pi'}
			<input
				class="input input-xs w-32"
				aria-label="{lane} provider"
				placeholder="provider"
				bind:value={agent.provider}
			/>
		{/if}
		<input
			class="input input-xs w-48"
			aria-label="{lane} model"
			placeholder="model"
			bind:value={agent.model}
		/>
	{/if}
</div>
