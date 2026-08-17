import { SvelteSet } from 'svelte/reactivity';
import type { DeckSession } from '$lib/types';
import { ownsWorktreeBranch } from '$lib/pr';
import { batchErrorMessage, deleteSequentially } from '$lib/delete-flow-core';

export async function requestDelete(
	id: string,
	opts: { deleteWorktree?: boolean; deleteBranch?: boolean }
): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(opts)
	});
	if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}

// Shared session-delete flow for the home list and the session-view sidebar:
// the confirm-modal state, per-id in-flight tracking (deletes run in the
// background so several can be in flight at once, issue #59), and the DELETE
// request with worktree/branch options. `onDeleted` fires once a delete
// succeeds (both the plain and worktree paths funnel through `run`), letting the
// session page navigate to a neighbour when the open session is the one removed.
// `onBatchStart` fires once a confirmed batch begins, letting the homepage drop
// select mode before the first request goes out (issue #211).
// Methods are arrow fields so they can be passed as bare callbacks (e.g.
// onDelete={flow.request}).
export class DeleteFlow {
	target = $state<DeckSession | null>(null);
	// The homepage's selection, awaiting one confirm for the whole batch (#211).
	// Mutually exclusive with `target`: only one confirm is ever open.
	batch = $state<DeckSession[] | null>(null);
	// Non-null only while a batch is walking, driving its progress readout.
	progress = $state<{ done: number; total: number } | null>(null);
	worktree = $state(true);
	branch = $state(true);
	readonly deletingIds = new SvelteSet<string>();
	error = $state<string | null>(null);

	constructor(
		private refresh: () => Promise<void>,
		private onDeleted: (s: DeckSession) => void = () => {},
		private onBatchStart: () => void = () => {}
	) {}

	// Open the confirm modal for a worktree session; plain sessions just get a
	// native confirm and delete straight away.
	request = (s: DeckSession) => {
		if (this.deletingIds.has(s.id)) return;
		if (s.worktree) {
			this.worktree = true;
			this.branch = ownsWorktreeBranch(s.worktree, s.pr);
			this.target = s;
			return;
		}
		if (confirm(`Kill and remove "${s.title}"?`)) this.run(s, {});
	};

	// Open the one confirm for a whole selection. The batch sends a single pair of
	// flags and the server applies each per session, so the branch option only needs
	// *some* selected branch to be deck-owned (removeSessionWorktree drops it for
	// the rest) rather than gating the batch on all of them.
	requestBatch = (list: DeckSession[]) => {
		const pending = list.filter((s) => !this.deletingIds.has(s.id));
		if (pending.length === 0) return;
		this.worktree = true;
		this.branch = pending.some((s) => !!s.worktree && ownsWorktreeBranch(s.worktree, s.pr));
		this.batch = pending;
	};

	// Run a confirmed batch against the same per-session DELETE, sequentially, with
	// one refresh at the end. Every id is marked in-flight up front so each row
	// shows its spinner and keeps its own delete button disabled for the whole run.
	runBatch = async (
		list: DeckSession[],
		opts: { deleteWorktree?: boolean; deleteBranch?: boolean }
	) => {
		this.batch = null; // close the confirm immediately; cleanup runs in the background
		if (list.length === 0) return;
		this.onBatchStart();
		for (const s of list) this.deletingIds.add(s.id);
		this.error = null;
		this.progress = { done: 0, total: list.length };
		const failed = await deleteSequentially(
			list,
			async (s) => {
				await requestDelete(s.id, opts);
				this.onDeleted(s);
			},
			(s, done) => {
				this.deletingIds.delete(s.id);
				this.progress = { done, total: list.length };
			}
		);
		this.progress = null;
		this.error = batchErrorMessage(failed, list.length);
		try {
			await this.refresh();
		} catch {
			// ignore; the poll will drop the rows
		}
	};

	run = async (s: DeckSession, opts: { deleteWorktree?: boolean; deleteBranch?: boolean }) => {
		if (this.deletingIds.has(s.id)) return;
		this.target = null; // close the confirm modal immediately; cleanup runs in the background
		this.deletingIds.add(s.id);
		try {
			await requestDelete(s.id, opts);
			// Delete succeeded: clear any prior failure, then notify. The open
			// session's page navigates to its neighbour here, only now the row is
			// really gone, so a failed delete instead keeps you on the page with the
			// error. Finally reconcile the list; a refresh failure is transient (the
			// 5s poll catches up) and must not be reported as a delete failure.
			this.error = null;
			this.onDeleted(s);
			try {
				await this.refresh();
			} catch {
				// ignore; the poll will drop the row
			}
		} catch {
			this.error = `Couldn't remove "${s.title}".`;
		} finally {
			this.deletingIds.delete(s.id);
		}
	};
}
