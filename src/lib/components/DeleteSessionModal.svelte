<script lang="ts">
	import type { DeleteFlow } from '$lib/delete-flow.svelte';
	import { ownsWorktreeBranch } from '$lib/pr';

	// Confirm modal for deleting sessions: one worktree session (home list or
	// session view), or the homepage's whole selection (`flow.batch`, issue #211).
	// All state lives on the delete flow (see delete-flow.svelte.ts).
	let { flow }: { flow: DeleteFlow } = $props();

	// The sessions this confirm covers, either way, so the worktree/branch options
	// read off one list. Only one of target/batch is ever set.
	let sessions = $derived(flow.batch ?? (flow.target ? [flow.target] : []));
	let worktrees = $derived(sessions.filter((s) => !!s.worktree));

	// Whether deck owns a branch here, so the "Delete the branch" option is offered
	// (matches the server's cleanup decision and the flow's default seeding). One
	// owned branch is enough for a batch: the server drops the flag per session for
	// the ones it doesn't own.
	let ownsBranch = $derived(worktrees.some((s) => ownsWorktreeBranch(s.worktree!, s.pr)));

	// How many of the selection the options actually apply to, so the checkboxes
	// have context and the untouched sessions are called out.
	let batchNote = $derived.by(() => {
		const [picked, total] = [worktrees.length, sessions.length];
		if (picked === 0) return 'None of them live in a git worktree.';
		if (picked === total) return 'They all live in a git worktree.';
		return `${picked} of ${total} live in a git worktree; the rest are unaffected by the options below.`;
	});

	function close() {
		flow.target = null;
		flow.batch = null;
	}

	function confirm() {
		const opts = { deleteWorktree: flow.worktree, deleteBranch: flow.branch };
		if (flow.batch) flow.runBatch(flow.batch, opts);
		else if (flow.target) flow.run(flow.target, opts);
	}
</script>

{#if sessions.length > 0}
	<div class="modal modal-open modal-bottom sm:modal-middle" role="dialog">
		<div class="modal-box max-w-sm">
			{#if flow.batch}
				<h3 class="mb-2 text-lg font-semibold">
					Remove {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
				</h3>
				<p class="mb-3 text-sm opacity-70">Kills every selected session. {batchNote}</p>
			{:else if flow.target}
				<h3 class="mb-2 text-lg font-semibold">Remove "{flow.target.title}"</h3>
				<p class="mb-3 text-sm opacity-70">
					Kills the session. This session lives in a git worktree on branch
					<span class="font-mono">{flow.target.worktree?.branch}</span>.
				</p>
			{/if}
			{#if worktrees.length > 0}
				<div class="space-y-2">
					<label class="label cursor-pointer justify-start gap-2">
						<input type="checkbox" class="checkbox checkbox-sm" bind:checked={flow.worktree} />
						<span>Delete the worktree</span>
					</label>
					<label class="label cursor-pointer justify-start gap-2">
						<input
							type="checkbox"
							class="checkbox checkbox-sm"
							bind:checked={flow.branch}
							disabled={!flow.worktree || !ownsBranch}
						/>
						<span>
							Delete the branch
							{#if !ownsBranch}
								<span class="opacity-50">(existing branch, kept)</span>
							{:else if flow.batch}
								<span class="opacity-50">(only where deck created it)</span>
							{/if}
						</span>
					</label>
				</div>
			{/if}
			<div class="modal-action">
				<button class="btn" onclick={close}>Cancel</button>
				<button class="btn btn-error" onclick={confirm}>Remove</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={close} aria-label="close"></button>
	</div>
{/if}
