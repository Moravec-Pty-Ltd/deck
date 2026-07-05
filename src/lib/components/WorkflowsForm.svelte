<script lang="ts">
	import type { Project, Workflow, WorkflowContext, WorkflowStep } from '$lib/types';
	import { SESSION_PLACEHOLDERS, REVIEW_PLACEHOLDERS } from '$lib/placeholders';
	import { createProjectSaver, move } from './project-form.svelte';
	import { Plus, Trash2, ChevronUp, ChevronDown, Check, Workflow as WorkflowIcon } from '@lucide/svelte';

	// Per-project workflows editor (issue #111), following DevConfigForm's
	// working-copy shape: edit a cloned flat form model, clean + POST the whole
	// list on save (the API carries other project fields across).
	let { project, onchanged }: { project: Project; onchanged: () => void } = $props();

	// One editable shape for every step type: switching the type keeps whatever
	// was typed, and clean() keeps only the fields the type actually has.
	// `key` exists only for the each-block: the list is reorderable, so an
	// index key would make edits stick to positions instead of steps.
	interface EditStep {
		key: number;
		type: WorkflowStep['type'];
		name: string;
		command: string;
		prompt: string;
		model: string;
		retries: string;
		question: string;
	}
	interface EditWorkflow {
		id: string;
		name: string;
		context: WorkflowContext;
		steps: EditStep[];
	}

	const CONTEXTS: { id: WorkflowContext; label: string }[] = [
		{ id: 'issue', label: 'issue (like New)' },
		{ id: 'pr', label: 'pr (like Review)' },
		{ id: 'worktree', label: 'existing worktree' },
		{ id: 'none', label: 'none' }
	];
	const STEP_TYPES: WorkflowStep['type'][] = ['run', 'agent', 'gate', 'ask'];

	let workflows = $state<EditWorkflow[]>(clone(project.workflows));
	let open = $state(false);
	let localError = $state('');
	const saver = createProjectSaver(() => onchanged());

	let stepSeq = 0;
	function blankStep(type: WorkflowStep['type'] = 'agent'): EditStep {
		return { key: ++stepSeq, type, name: '', command: '', prompt: '', model: '', retries: '', question: '' };
	}

	function cloneStep(s: WorkflowStep): EditStep {
		return {
			...blankStep(s.type),
			name: s.name,
			command: 'command' in s ? s.command : '',
			prompt: s.type === 'agent' ? s.prompt : '',
			model: s.type === 'agent' ? (s.model ?? '') : '',
			retries: s.type === 'gate' && s.retries !== undefined ? String(s.retries) : '',
			question: s.type === 'ask' ? s.question : ''
		};
	}

	function clone(list: Workflow[] | undefined): EditWorkflow[] {
		return (list ?? []).map((w) => ({
			id: w.id,
			name: w.name,
			context: w.context,
			steps: w.steps.map(cloneStep)
		}));
	}

	function newId(): string {
		return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	}

	function addWorkflow() {
		workflows = [
			...workflows,
			{ id: newId(), name: '', context: 'issue', steps: [blankStep()] }
		];
	}

	// --- build + save ---
	function cleanStep(s: EditStep): WorkflowStep | null {
		const name = s.name.trim();
		if (!name) return null;
		switch (s.type) {
			case 'run': {
				const command = s.command.trim();
				return command ? { type: 'run', name, command } : null;
			}
			case 'gate': {
				const command = s.command.trim();
				if (!command) return null;
				const retries = Number(s.retries);
				const hasRetries = s.retries.trim() !== '' && Number.isInteger(retries) && retries >= 0;
				return { type: 'gate', name, command, retries: hasRetries ? retries : undefined };
			}
			case 'agent': {
				const prompt = s.prompt.trim();
				if (!prompt) return null;
				return { type: 'agent', name, prompt, model: s.model.trim() || undefined };
			}
			case 'ask': {
				const question = s.question.trim();
				return question ? { type: 'ask', name, question } : null;
			}
		}
	}

	function buildWorkflows(): Workflow[] {
		return workflows.map((w) => ({
			id: w.id,
			name: w.name.trim(),
			context: w.context,
			steps: w.steps.map(cleanStep).filter((s): s is WorkflowStep => s !== null)
		}));
	}

	// Reject a save that would silently drop what's on screen: a half-filled
	// step must be completed or removed, never quietly deleted by the filter.
	function validationError(): string {
		for (const w of workflows) {
			if (!w.name.trim()) return 'every workflow needs a name';
			for (const s of w.steps) {
				if (!cleanStep(s)) return `incomplete ${s.type} step in "${w.name.trim()}"`;
			}
			if (!w.steps.length) return `"${w.name.trim()}" needs at least one step`;
		}
		return '';
	}

	function save() {
		localError = validationError();
		if (localError) return;
		// template/lastBase resolve from the body on this endpoint, so send the
		// current values or the save would clear them (sources/group/reviewPrompt
		// carry server-side).
		saver.save({
			path: project.path,
			name: project.name,
			template: project.template,
			lastBase: project.lastBase,
			workflows: buildWorkflows()
		});
	}
</script>

<div class="mt-3">
	<button class="flex items-center gap-2 text-xs font-medium opacity-60" onclick={() => (open = !open)}>
		<WorkflowIcon size={13} />
		Workflows{#if workflows.length}<span class="badge badge-ghost badge-xs">{workflows.length}</span>{/if}
		<ChevronDown size={13} class={open ? '' : '-rotate-90'} />
	</button>

	{#if open}
		<div class="mt-2 space-y-4 rounded-box border border-dashed border-base-300 p-3">
			{#if localError || saver.errorMsg}
				<div class="alert alert-error py-1 text-xs">{localError || saver.errorMsg}</div>
			{/if}

			<p class="text-[11px] opacity-50">
				Steps run in order in the session cwd. Prompts, commands, and questions take
				{SESSION_PLACEHOLDERS} (pr context adds {REVIEW_PLACEHOLDERS}) plus
				<code class="font-mono">[step:&lt;name&gt;]</code> for a previous step's output. In
				commands, token values are inserted single-quoted, so write
				<code class="font-mono">--title [issue_title]</code> without extra quotes. A failed
				gate re-runs the nearest agent step above it with the failure output (default 1 retry).
				With no workflows configured, the default first prompt and review prompt above act as the
				two built-in workflows.
			</p>

			<div class="space-y-3">
				{#each workflows as w, wi (w.id)}
					<div class="rounded-box border border-base-300 bg-base-200/40 p-2">
						<div class="flex items-center gap-2">
							<input class="input input-xs flex-1" placeholder="name (Dev)" bind:value={w.name} />
							<select class="select select-xs w-44" bind:value={w.context}>
								{#each CONTEXTS as c (c.id)}
									<option value={c.id}>{c.label}</option>
								{/each}
							</select>
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => (workflows = workflows.filter((_, idx) => idx !== wi))}
								aria-label="Remove workflow"
							>
								<Trash2 size={13} />
							</button>
						</div>

						<div class="mt-2 space-y-1">
							{#each w.steps as s, si (s.key)}
								<div class="rounded border border-base-300 p-1.5">
									<div class="flex items-center gap-2">
										<select
											class="select select-xs w-20"
											bind:value={s.type}
											aria-label="Step type"
										>
											{#each STEP_TYPES as t (t)}
												<option value={t}>{t}</option>
											{/each}
										</select>
										<input class="input input-xs flex-1" placeholder="step name" bind:value={s.name} />
										{#if s.type === 'gate'}
											<input
												class="input input-xs w-20"
												type="number"
												min="0"
												max="10"
												placeholder="retries"
												bind:value={s.retries}
											/>
										{/if}
										{#if s.type === 'agent'}
											<input class="input input-xs w-32" placeholder="model (optional)" bind:value={s.model} />
										{/if}
										<button class="btn btn-ghost btn-xs" onclick={() => { w.steps = move(w.steps, si, -1); workflows = [...workflows]; }} aria-label="Up"><ChevronUp size={12} /></button>
										<button class="btn btn-ghost btn-xs" onclick={() => { w.steps = move(w.steps, si, 1); workflows = [...workflows]; }} aria-label="Down"><ChevronDown size={12} /></button>
										<button class="btn btn-ghost btn-xs" onclick={() => { w.steps = w.steps.filter((_, idx) => idx !== si); workflows = [...workflows]; }} aria-label="Remove step"><Trash2 size={12} /></button>
									</div>
									{#if s.type === 'run' || s.type === 'gate'}
										<input
											class="input input-xs mt-1 w-full font-mono"
											placeholder={s.type === 'gate' ? 'command (pnpm check && pnpm test)' : 'command (gh pr create --fill)'}
											bind:value={s.command}
										/>
									{:else if s.type === 'agent'}
										<textarea
											class="textarea textarea-xs mt-1 w-full"
											rows="2"
											placeholder="prompt (one agent turn in the session)"
											bind:value={s.prompt}
										></textarea>
									{:else}
										<input
											class="input input-xs mt-1 w-full"
											placeholder="question to block on (answered in the session view)"
											bind:value={s.question}
										/>
									{/if}
								</div>
							{/each}
						</div>
						<button
							class="btn btn-ghost btn-xs mt-1"
							onclick={() => { w.steps = [...w.steps, blankStep()]; workflows = [...workflows]; }}
						>
							<Plus size={12} /> step
						</button>
					</div>
				{/each}
			</div>
			<button class="btn btn-ghost btn-xs" onclick={addWorkflow}><Plus size={12} /> workflow</button>

			<div class="flex items-center justify-end gap-2">
				{#if saver.saved}<span class="flex items-center gap-1 text-xs text-success"><Check size={13} /> saved</span>{/if}
				<button class="btn btn-sm btn-primary" disabled={saver.busy} onclick={save}>Save workflows</button>
			</div>
		</div>
	{/if}
</div>
