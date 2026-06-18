<script lang="ts">
	import { CircleHelp, Check } from '@lucide/svelte';

	type Option = { label: string; description?: string };
	type Question = {
		question: string;
		header?: string;
		multiSelect?: boolean;
		options: Option[];
	};

	let {
		block,
		answered = false,
		answer = null,
		onanswer
	}: {
		block: Record<string, any>;
		answered?: boolean;
		answer?: { header: string; labels: string[] }[] | null;
		onanswer?: (text: string, answers: { header: string; labels: string[] }[]) => void;
	} = $props();

	const questions: Question[] = (block.input?.questions ?? []) as Question[];

	let selected = $state<string[][]>(questions.map(() => []));
	let other = $state<string[]>(questions.map(() => ''));

	function toggle(qi: number, label: string) {
		const q = questions[qi];
		if (q.multiSelect) {
			selected[qi] = selected[qi].includes(label)
				? selected[qi].filter((l) => l !== label)
				: [...selected[qi], label];
		} else {
			selected[qi] = selected[qi][0] === label ? [] : [label];
		}
		selected = [...selected];
	}

	const canSubmit = $derived(
		questions.every((_, i) => selected[i].length > 0 || other[i].trim().length > 0)
	);

	function submit() {
		const answers = questions.map((q, i) => {
			const labels = [...selected[i]];
			if (other[i].trim()) labels.push(other[i].trim());
			return { header: q.header ?? q.question, labels };
		});
		const text =
			`Answering your question${questions.length > 1 ? 's' : ''}:\n` +
			answers.map((a) => `- ${a.header}: ${a.labels.join(', ')}`).join('\n');
		onanswer?.(text, answers);
	}
</script>

<div class="mx-1 overflow-hidden rounded-box border border-primary/40 bg-primary/5 text-sm">
	<div class="flex items-center gap-2 border-b border-primary/20 px-3 py-1.5">
		<CircleHelp size={14} class="shrink-0 text-primary" />
		<span class="font-medium">Claude is asking</span>
		{#if answered}<span class="badge badge-success badge-xs ml-auto shrink-0">answered</span>{/if}
	</div>

	<div class="space-y-3 px-3 py-3">
		{#each questions as q, qi (qi)}
			<div class="space-y-1.5">
				{#if q.header}<div class="text-xs font-medium opacity-60">{q.header}</div>{/if}
				<div class="break-words">{q.question}</div>

				{#if answered}
					<div class="flex flex-wrap gap-1.5">
						{#each answer?.[qi]?.labels ?? [] as l, li (li)}
							<span class="badge badge-success badge-sm gap-1"><Check size={11} /> {l}</span>
						{/each}
					</div>
				{:else}
					<div class="flex flex-col gap-1.5">
						{#each q.options as opt, oi (oi)}
							<button
								class="btn btn-sm h-auto justify-start py-1.5 text-left {selected[qi].includes(opt.label)
									? 'btn-primary'
									: 'btn-outline'}"
								onclick={() => toggle(qi, opt.label)}
							>
								<span class="flex min-w-0 flex-col">
									<span class="font-medium">{opt.label}</span>
									{#if opt.description}
										<span class="text-xs font-normal break-words whitespace-normal opacity-70"
											>{opt.description}</span
										>
									{/if}
								</span>
							</button>
						{/each}
						<input
							class="input input-sm mt-0.5"
							placeholder="other (optional)"
							bind:value={other[qi]}
						/>
					</div>
				{/if}
			</div>
		{/each}

		{#if !answered}
			<button class="btn btn-primary btn-sm w-full" onclick={submit} disabled={!canSubmit}>
				Send answer{questions.length > 1 ? 's' : ''}
			</button>
		{/if}
	</div>
</div>
