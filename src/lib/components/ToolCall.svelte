<script lang="ts">
	import Linked from './Linked.svelte';
	import Diff from './Diff.svelte';
	import { lineDiff, addedLines, looksLikeDiff, parseUnified } from '$lib/diff';
	import { shortPath } from '$lib/time';
	import { toolOutput } from '$lib/toolOutput.svelte';
	import {
		Wrench,
		Terminal,
		FileText,
		FilePen,
		FilePlus,
		Search,
		FolderSearch,
		ListChecks,
		Globe,
		Bot,
		Circle,
		CircleDot,
		CircleCheck
	} from '@lucide/svelte';

	type AnyBlock = Record<string, any>;
	let { block, result }: { block: AnyBlock; result?: AnyBlock } = $props();

	const name = $derived(block.name as string);
	const input = $derived((block.input ?? {}) as AnyBlock);

	const icons: Record<string, typeof Wrench> = {
		Bash: Terminal,
		Read: FileText,
		Edit: FilePen,
		MultiEdit: FilePen,
		NotebookEdit: FilePen,
		Write: FilePlus,
		Grep: Search,
		Glob: FolderSearch,
		TodoWrite: ListChecks,
		WebFetch: Globe,
		WebSearch: Search,
		Task: Bot
	};
	const Icon = $derived(icons[name] ?? Wrench);

	const fileTools = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

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
		if (name === 'Task') return String(input.subagent_type ?? input.description ?? '');
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

	const resText = $derived(resultText(result));
	const isErr = $derived(!!result?.is_error);
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
						<div class="terminal-output max-h-72 overflow-y-auto rounded-box border border-base-300 px-2 py-1.5 {isErr ? 'text-error' : 'opacity-80'}"><Linked text={shownResult} />{#if clipped}{'\n'}…{/if}</div>
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

		{#if !hideResult && name !== 'Bash'}
			{#if isErr}
				<div class="terminal-output max-h-72 overflow-y-auto rounded-box border border-error/40 bg-error/5 px-2 py-1.5 text-error"><Linked text={shownResult} /></div>
			{:else if resText}
				<details>
					<summary class="cursor-pointer select-none text-xs opacity-50">output</summary>
					<div class="terminal-output mt-1 max-h-72 overflow-y-auto rounded-box border border-base-300 px-2 py-1.5 opacity-80"><Linked text={shownResult} />{#if clipped}{'\n'}…{/if}</div>
				</details>
			{/if}
		{/if}

		{#if !fileTools.has(name) && name !== 'Bash' && name !== 'TodoWrite' && name !== 'Grep' && name !== 'Glob' && name !== 'WebFetch' && name !== 'WebSearch' && name !== 'Task'}
			<details>
				<summary class="cursor-pointer select-none text-xs opacity-50">input</summary>
				<pre class="terminal-output mt-1 max-h-60 overflow-y-auto opacity-70">{JSON.stringify(input, null, 2)}</pre>
			</details>
		{/if}
	</div>
</div>
