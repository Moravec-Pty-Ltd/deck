<script lang="ts">
	import AnsiText from './AnsiText.svelte';
	import Diff from './Diff.svelte';
	import { lineDiff, addedLines, looksLikeDiff, parseUnified } from '$lib/diff';
	import { shortPath } from '$lib/time';
	import { toolOutput } from '$lib/toolOutput.svelte';
	import { toolIcon } from '$lib/tool-icons';
	import RollingCount from './RollingCount.svelte';
	import { Circle, CircleDot, CircleCheck, CircleX, ChevronRight } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import Markdown from './Markdown.svelte';
	import { formatDuration, isLaunchReceipt, type AgentState } from '$lib/subagents-core';
	import { formatTokens } from '$lib/context-core';

	type AnyBlock = Record<string, any>;
	// `steps` counts what a subagent launched by this call has done so far;
	// `children` renders those steps, only while the card is open. `agent` is the
	// subagent's live state (status, what it's doing, its final report).
	let {
		block,
		result,
		agent,
		agentElapsed,
		steps = 0,
		open = false,
		ontoggle,
		children
	}: {
		block: AnyBlock;
		result?: AnyBlock;
		agent?: AgentState;
		agentElapsed?: (agent: AgentState) => number;
		steps?: number;
		open?: boolean;
		ontoggle?: () => void;
		children?: Snippet;
	} = $props();

	const name = $derived(block.name as string);
	const input = $derived((block.input ?? {}) as AnyBlock);

	const Icon = $derived(toolIcon(name));

	const fileTools = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
	const subagentTools = new Set(['Agent', 'Task']);

	const headerArg = $derived.by(() => {
		if (fileTools.has(name) && input.file_path) {
			const range =
				typeof input.offset === 'number'
					? `:${input.offset}${input.limit ? `+${input.limit}` : ''}`
					: '';
			return shortPath(String(input.file_path)) + range;
		}
		if (name === 'Bash') return String(input.description ?? input.command ?? '').split('\n')[0];
		if (name === 'Grep' || name === 'Glob') return String(input.pattern ?? '');
		if (name === 'WebFetch') return String(input.url ?? '');
		if (name === 'WebSearch') return String(input.query ?? '');
		// Description first: parallel subagents usually share a type.
		if (subagentTools.has(name)) return String(input.description ?? input.subagent_type ?? '');
		if (name === 'TodoWrite') return `${(input.todos ?? []).length} items`;
		return String(input.description ?? input.command ?? input.file_path ?? '').split('\n')[0];
	});

	function resultText(r: AnyBlock | undefined): string {
		if (!r) return '';
		if (typeof r.content === 'string') return r.content;
		if (Array.isArray(r.content)) {
			return r.content
				.filter((c: AnyBlock) => c.type === 'text')
				.map((c: AnyBlock) => c.text)
				.join('\n');
		}
		return '';
	}

	// A background subagent's call returns a launch receipt at once; its answer
	// comes later as the agent's report, shown in place of the receipt.
	const resText = $derived.by(() => {
		const text = resultText(result);
		return agent && isLaunchReceipt(text) ? '' : text;
	});
	// A foreground agent's answer is already its call result.
	const isErr = $derived(!!result?.is_error);
	// What the agent answered: its report, or a foreground agent's call result.
	const answer = $derived(isErr ? '' : agent?.summary || resText);
	let answerOpen = $state(false);
	const MAX = 6000;
	const clipped = $derived(resText.length > MAX);
	const shownResult = $derived(clipped ? resText.slice(0, MAX) : resText);

	// Edit/Write own their diff; the textual result ("File updated") is just noise
	// unless it errored.
	const hideResult = $derived(
		!isErr && (name === 'Edit' || name === 'MultiEdit' || name === 'Write')
	);
</script>

{#snippet diffToggle()}
	<button
		type="button"
		class="cursor-pointer select-none text-xs opacity-50 hover:opacity-80"
		onclick={() => (toolOutput.open = !toolOutput.open)}
	>
		{toolOutput.open ? 'hide diff' : 'show diff'}
	</button>
{/snippet}

{#if subagentTools.has(name)}
	{@render agentCard()}
{:else}
<div class="mx-1 overflow-hidden rounded-box border border-base-300 bg-base-100 text-sm">
	<div class="flex items-center gap-2 px-3 py-1.5">
		<Icon size={14} class="shrink-0 opacity-60" />
		<span class="shrink-0 font-medium">{name}</span>
		<span class="truncate font-mono text-xs opacity-60">{headerArg}</span>
		{#if isErr}<span class="badge badge-error badge-xs ml-auto shrink-0">error</span>{/if}
	</div>

	<div class="space-y-2 px-3 pb-2">
		{#if name === 'Bash'}
			<div class="terminal-output rounded-box bg-base-200 px-2 py-1.5">
				<span class="opacity-50 select-none">$ </span>{input.command}
			</div>
			{#if resText}
				<button
					type="button"
					class="cursor-pointer select-none text-xs opacity-50 hover:opacity-80"
					onclick={() => (toolOutput.open = !toolOutput.open)}
				>
					{toolOutput.open ? 'hide output' : 'show output'}{#if isErr}
						<span class="text-error"> (error)</span>{/if}
				</button>
				{#if toolOutput.open}
					{#if looksLikeDiff(resText)}
						<Diff lines={parseUnified(resText)} />
					{:else}
						<div class="terminal-output max-h-72 overflow-y-auto rounded-box border border-base-300 px-2 py-1.5 {isErr ? 'text-error' : 'opacity-80'}"><AnsiText text={shownResult} />{#if clipped}{'\n'}…{/if}</div>
					{/if}
				{/if}
			{/if}
		{:else if name === 'Edit'}
			{@render diffToggle()}
			{#if toolOutput.open}
				<Diff lines={lineDiff(String(input.old_string ?? ''), String(input.new_string ?? ''))} />
			{/if}
		{:else if name === 'MultiEdit'}
			{@render diffToggle()}
			{#if toolOutput.open}
				{#each (input.edits ?? []) as e, i (i)}
					<Diff lines={lineDiff(String(e.old_string ?? ''), String(e.new_string ?? ''))} />
				{/each}
			{/if}
		{:else if name === 'Write'}
			{@render diffToggle()}
			{#if toolOutput.open}
				<Diff lines={addedLines(String(input.content ?? ''))} max={400} />
			{/if}
		{:else if name === 'TodoWrite'}
			<ul class="space-y-0.5">
				{#each (input.todos ?? []) as t, i (i)}
					<li class="flex items-center gap-1.5">
						{#if t.status === 'completed'}
							<CircleCheck size={13} class="shrink-0 text-success" />
							<span class="opacity-50 line-through">{t.content}</span>
						{:else if t.status === 'in_progress'}
							<CircleDot size={13} class="shrink-0 text-warning" />
							<span class="font-medium">{t.content}</span>
						{:else}
							<Circle size={13} class="shrink-0 opacity-40" />
							<span class="opacity-80">{t.content}</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if steps > 0 && children}
			<button
				type="button"
				class="flex cursor-pointer select-none items-center gap-1 text-xs opacity-50 hover:opacity-80"
				onclick={ontoggle}
				aria-expanded={open}
			>
				<ChevronRight size={12} class="shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
				<RollingCount value={steps} /> steps
			</button>
			{#if open}
				<div class="space-y-3 border-l border-base-300 pl-2">{@render children()}</div>
			{/if}
		{/if}

		{#if !hideResult && name !== 'Bash'}
			{#if isErr}
				<div class="terminal-output max-h-72 overflow-y-auto rounded-box border border-error/40 bg-error/5 px-2 py-1.5 text-error"><AnsiText text={shownResult} /></div>
			{:else if resText}
				<details>
					<summary class="cursor-pointer select-none text-xs opacity-50">output</summary>
					<div class="terminal-output mt-1 max-h-72 overflow-y-auto rounded-box border border-base-300 px-2 py-1.5 opacity-80"><AnsiText text={shownResult} />{#if clipped}{'\n'}…{/if}</div>
				</details>
			{/if}
		{/if}

		{#if !fileTools.has(name) && name !== 'Bash' && name !== 'TodoWrite' && name !== 'Grep' && name !== 'Glob' && name !== 'WebFetch' && name !== 'WebSearch' && !subagentTools.has(name)}
			<details>
				<summary class="cursor-pointer select-none text-xs opacity-50">input</summary>
				<pre class="terminal-output mt-1 max-h-60 overflow-y-auto opacity-70">{JSON.stringify(input, null, 2)}</pre>
			</details>
		{/if}
	</div>
</div>
{/if}

<!-- A subagent's card, kept to two or three short lines so a fan-out of several
     stays readable on a phone: status and title with the elapsed time, what it
     is doing while it runs, then its steps, tokens and answer, each opening in
     place. -->
{#snippet agentCard()}
	<div class="mx-1 overflow-hidden rounded-box border border-base-300 bg-base-100 text-sm">
		<div class="flex items-center gap-2 px-3 pt-1.5">
			{#if agent?.status === 'running'}
				<span class="loading loading-spinner loading-xs shrink-0 text-info" aria-label="running"></span>
			{:else if agent?.status === 'completed'}
				<CircleCheck size={14} class="shrink-0 text-success" aria-label="done" />
			{:else if agent?.status === 'failed' || isErr}
				<CircleX size={14} class="shrink-0 text-error" aria-label="failed" />
			{:else if agent?.status === 'stopped'}
				<CircleX size={14} class="shrink-0 text-warning" aria-label="stopped" />
			{:else}
				<Icon size={14} class="shrink-0 opacity-60" />
			{/if}
			<span class="min-w-0 flex-1 truncate font-medium">{headerArg || 'Subagent'}</span>
			{#if agent && agent.durationMs > 0}
				<span class="shrink-0 text-xs tabular-nums opacity-50">
					{formatDuration(agentElapsed ? agentElapsed(agent) : agent.durationMs)}
				</span>
			{/if}
		</div>
		{#if agent?.status === 'running'}
			<div class="truncate pr-3 pl-[2.125rem] text-xs opacity-60">{agent.activity || 'starting…'}</div>
		{/if}
		<div class="flex items-center gap-3 pt-0.5 pr-3 pb-1.5 pl-[2.125rem] text-xs">
			{#if steps > 0 && children}
				<button
					type="button"
					class="flex cursor-pointer select-none items-center gap-0.5 opacity-60 hover:opacity-90"
					onclick={ontoggle}
					aria-expanded={open}
				>
					<ChevronRight size={12} class="shrink-0 transition-transform {open ? 'rotate-90' : ''}" />
					<RollingCount value={steps} /> steps
				</button>
			{/if}
			{#if agent && agent.tokens > 0}
				<span class="tabular-nums opacity-40">{formatTokens(agent.tokens)} tokens</span>
			{/if}
			{#if answer}
				<button
					type="button"
					class="ml-auto flex cursor-pointer select-none items-center gap-0.5 opacity-60 hover:opacity-90"
					onclick={() => (answerOpen = !answerOpen)}
					aria-expanded={answerOpen}
				>
					result <ChevronRight size={12} class="shrink-0 transition-transform {answerOpen ? 'rotate-90' : ''}" />
				</button>
			{/if}
		</div>
		{#if answerOpen && answer}
			<div class="mx-3 mb-2 max-h-96 overflow-y-auto rounded-box border border-base-300 px-2 py-1.5">
				<Markdown source={answer} />
			</div>
		{/if}
		{#if isErr && resText}
			<div class="terminal-output mx-3 mb-2 max-h-72 overflow-y-auto rounded-box border border-error/40 bg-error/5 px-2 py-1.5 text-error"><AnsiText text={shownResult} /></div>
		{/if}
		{#if open && steps > 0 && children}
			<div class="mx-3 mb-2 space-y-3 border-l border-base-300 pl-2">{@render children()}</div>
		{/if}
	</div>
{/snippet}
