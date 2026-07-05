<script lang="ts">
	import type { DeleteFlow } from '$lib/delete-flow.svelte';

	// Confirm modal for deleting a worktree session, shared by the home list and
	// the session view. All state lives on the delete flow (see delete-flow.svelte.ts).
	let { flow }: { flow: DeleteFlow } = $props();
</script>

{#if flow.target}
	<div class="modal modal-open" role="dialog">
		<div class="modal-box max-w-sm">
			<h3 class="mb-2 text-lg font-semibold">Remove "{flow.target.title}"</h3>
			<p class="mb-3 text-sm opacity-70">
				Kills the session. This session lives in a git worktree on branch
				<span class="font-mono">{flow.target.worktree?.branch}</span>.
			</p>
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
						disabled={!flow.worktree || !flow.target.worktree?.createdBranch}
					/>
					<span>
						Delete the branch
						{#if !flow.target.worktree?.createdBranch}
							<span class="opacity-50">(existing branch, kept)</span>
						{/if}
					</span>
				</label>
			</div>
			<div class="modal-action">
				<button class="btn" onclick={() => (flow.target = null)}>Cancel</button>
				<button
					class="btn btn-error"
					onclick={() =>
						flow.target &&
						flow.run(flow.target, { deleteWorktree: flow.worktree, deleteBranch: flow.branch })}
				>
					Remove
				</button>
			</div>
		</div>
		<button class="modal-backdrop" onclick={() => (flow.target = null)} aria-label="close"></button>
	</div>
{/if}
