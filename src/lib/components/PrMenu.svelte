<script lang="ts">
	import type { PrReviewDecision, SessionPR } from '$lib/types';
	import { PR_STATE_COLOR, REVIEW_COLOR } from '$lib/pr';
	import { GitPullRequest, Check, X, ExternalLink, GitMerge, ChevronLeft } from '@lucide/svelte';

	// GitHub's overall review decision, shown as a verdict line in the menu header.
	const VERDICT: Record<PrReviewDecision, { label: string; color?: string }> = {
		APPROVED: { label: 'Approved', color: REVIEW_COLOR.approve },
		CHANGES_REQUESTED: { label: 'Changes requested', color: REVIEW_COLOR.changes },
		REVIEW_REQUIRED: { label: 'Review required' }
	};

	// The captured-PR chip turned into an action menu (issue #44). The chip shows
	// the state-coloured icon (+ label at sm+); clicking opens a daisyUI dropdown
	// to open in browser, review, merge, or dismiss. Status itself is kept fresh by
	// the background sync, so review/merge POST through the action route (which
	// re-syncs server-side) and we just refetch via onChange.
	let { id, pr, onChange }: { id: string; pr: SessionPR; onChange: () => void } = $props();

	let menuEl = $state<HTMLDetailsElement>();
	let open = $state(false);
	let panel = $state<'menu' | 'review' | 'merge'>('menu');
	let busy = $state(false);
	let err = $state('');

	let decision = $state<'approve' | 'request-changes' | 'comment'>('approve');
	let message = $state('');
	let method = $state<'squash' | 'merge' | 'rebase'>('squash');
	let deleteBranch = $state(false);

	const prColor = $derived(pr.state ? PR_STATE_COLOR[pr.state] : undefined);
	const verdict = $derived(pr.reviewDecision ? VERDICT[pr.reviewDecision] : undefined);
	const approvals = $derived(pr.approvals ?? 0);
	const changes = $derived(pr.changesRequested ?? 0);
	// Merge is offered only for a clean, mergeable, open (non-draft) PR.
	const canMerge = $derived(pr.state === 'open' && pr.mergeable === 'MERGEABLE');
	const tallyTitle = $derived(`${approvals} approval${approvals === 1 ? '' : 's'}, ${changes} change request${changes === 1 ? '' : 's'}`);

	// Close on outside pointerdown; reset the panel/error whenever it closes.
	$effect(() => {
		if (!open) {
			panel = 'menu';
			err = '';
			return;
		}
		function onDown(e: PointerEvent) {
			if (menuEl && !menuEl.contains(e.target as Node)) open = false;
		}
		window.addEventListener('pointerdown', onDown, true);
		return () => window.removeEventListener('pointerdown', onDown, true);
	});

	async function post(payload: Record<string, unknown>): Promise<boolean> {
		busy = true;
		err = '';
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/pr`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				err = data?.message || 'action failed';
				return false;
			}
			onChange();
			return true;
		} catch {
			err = 'network error';
			return false;
		} finally {
			busy = false;
		}
	}

	async function submitReview() {
		if (await post({ action: 'review', decision, body: message })) {
			message = '';
			open = false;
		}
	}

	async function submitMerge() {
		if (await post({ action: 'merge', method, deleteBranch })) open = false;
	}

	async function dismiss() {
		busy = true;
		try {
			await fetch(`/api/sessions/${encodeURIComponent(id)}/pr`, { method: 'DELETE' });
		} catch {
			// best-effort: the next poll keeps the chip if the dismiss didn't land
		}
		busy = false;
		open = false;
		onChange();
	}
</script>

{#snippet marks(count: number, color: string, Icon: typeof Check)}
	{#if count > 0}
		<span class="inline-flex items-center" style="color:{color}">
			{#if count <= 5}
				{#each Array(count) as _, i (i)}<Icon size={11} strokeWidth={3} />{/each}
			{:else}
				<Icon size={11} strokeWidth={3} /><span class="ml-0.5 text-[10px] font-semibold leading-none">{count}</span>
			{/if}
		</span>
	{/if}
{/snippet}

<span class="inline-flex shrink-0 items-center gap-1">
	<details class="dropdown dropdown-end" bind:open bind:this={menuEl}>
		<summary
			class="badge badge-outline badge-sm cursor-pointer list-none gap-1 [&::-webkit-details-marker]:hidden"
			style={prColor ? `color:${prColor};border-color:${prColor}` : undefined}
			title="{pr.repo}#{pr.number}{pr.state ? ` (${pr.state})` : ''}"
		>
			<GitPullRequest size={12} />
			<span class="hidden sm:inline">{pr.repo}#{pr.number}</span>
		</summary>

		<div
			class="dropdown-content z-20 mt-1 w-64 rounded-box border border-base-300 bg-base-100 p-2 text-sm shadow-lg"
		>
			{#if panel === 'menu'}
				{#if verdict || approvals > 0 || changes > 0}
					<div class="mb-1 flex items-center gap-2 px-1 py-0.5 text-xs" title={tallyTitle}>
						{#if verdict}
							<span
								class="font-medium {verdict.color ? '' : 'opacity-70'}"
								style={verdict.color ? `color:${verdict.color}` : undefined}
							>
								{verdict.label}
							</span>
						{/if}
						{#if approvals > 0 || changes > 0}
							<span class="ml-auto inline-flex items-center gap-0.5">
								{@render marks(approvals, REVIEW_COLOR.approve, Check)}
								{@render marks(changes, REVIEW_COLOR.changes, X)}
							</span>
						{/if}
					</div>
				{/if}
				<ul class="menu menu-sm w-full p-0">
					<li>
						<a href={pr.url} target="_blank" rel="noopener noreferrer" onclick={() => (open = false)}>
							<ExternalLink size={14} /> Open in browser
						</a>
					</li>
					<li><button onclick={() => (panel = 'review')}><GitPullRequest size={14} /> Review</button></li>
					{#if canMerge}
						<li><button onclick={() => (panel = 'merge')}><GitMerge size={14} /> Merge</button></li>
					{/if}
					<li>
						<button onclick={dismiss} disabled={busy} class="text-error">
							<X size={14} /> Dismiss
						</button>
					</li>
				</ul>
			{:else if panel === 'review'}
				<div class="flex flex-col gap-2">
					<div class="join w-full">
						{#each [['approve', 'Approve'], ['request-changes', 'Request changes'], ['comment', 'Comment']] as [value, label] (value)}
							<button
								class="btn join-item btn-xs flex-1 {decision === value ? 'btn-active' : 'btn-ghost'}"
								onclick={() => (decision = value as typeof decision)}
							>
								{label}
							</button>
						{/each}
					</div>
					<textarea
						class="textarea textarea-bordered textarea-sm w-full"
						rows="3"
						bind:value={message}
						placeholder={decision === 'approve' ? 'Optional message' : 'Required message'}
					></textarea>
					{#if err}<p class="text-xs text-error">{err}</p>{/if}
					<div class="flex items-center justify-between">
						<button class="btn btn-ghost btn-xs gap-1" onclick={() => (panel = 'menu')}>
							<ChevronLeft size={12} /> Back
						</button>
						<button
							class="btn btn-primary btn-xs"
							onclick={submitReview}
							disabled={busy || (decision !== 'approve' && !message.trim())}
						>
							{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if} Submit
						</button>
					</div>
				</div>
			{:else}
				<div class="flex flex-col gap-2">
					<div class="join w-full">
						{#each [['squash', 'Squash'], ['merge', 'Merge'], ['rebase', 'Rebase']] as [value, label] (value)}
							<button
								class="btn join-item btn-xs flex-1 {method === value ? 'btn-active' : 'btn-ghost'}"
								onclick={() => (method = value as typeof method)}
							>
								{label}
							</button>
						{/each}
					</div>
					<label class="flex cursor-pointer items-center gap-2 text-xs">
						<input type="checkbox" class="checkbox checkbox-xs" bind:checked={deleteBranch} />
						Delete branch after merge
					</label>
					{#if err}<p class="text-xs text-error">{err}</p>{/if}
					<div class="flex items-center justify-between">
						<button class="btn btn-ghost btn-xs gap-1" onclick={() => (panel = 'menu')}>
							<ChevronLeft size={12} /> Back
						</button>
						<button class="btn btn-primary btn-xs" onclick={submitMerge} disabled={busy}>
							{#if busy}<span class="loading loading-spinner loading-xs"></span>{/if} Merge {method}
						</button>
					</div>
				</div>
			{/if}
		</div>
	</details>

	{#if approvals > 0 || changes > 0}
		<span class="hidden items-center gap-0.5 sm:inline-flex" title={tallyTitle}>
			{@render marks(approvals, REVIEW_COLOR.approve, Check)}
			{@render marks(changes, REVIEW_COLOR.changes, X)}
		</span>
	{/if}
</span>
