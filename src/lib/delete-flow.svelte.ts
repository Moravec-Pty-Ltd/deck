import { SvelteSet } from 'svelte/reactivity';
import type { DeckSession } from '$lib/types';

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
// request with worktree/branch options. `onDeleted` fires the moment a delete
// starts (both the plain and worktree paths funnel through `run`), letting the
// session page navigate away when the open session is the one being removed.
// Methods are arrow fields so they can be passed as bare callbacks (e.g.
// onDelete={flow.request}).
export class DeleteFlow {
	target = $state<DeckSession | null>(null);
	worktree = $state(true);
	branch = $state(true);
	readonly deletingIds = new SvelteSet<string>();
	error = $state<string | null>(null);

	constructor(
		private refresh: () => Promise<void>,
		private onDeleted: (s: DeckSession) => void = () => {}
	) {}

	// Open the confirm modal for a worktree session; plain sessions just get a
	// native confirm and delete straight away.
	request = (s: DeckSession) => {
		if (this.deletingIds.has(s.id)) return;
		if (s.worktree) {
			this.worktree = true;
			this.branch = s.worktree.createdBranch;
			this.target = s;
			return;
		}
		if (confirm(`Kill and remove "${s.title}"?`)) this.run(s, {});
	};

	run = async (s: DeckSession, opts: { deleteWorktree?: boolean; deleteBranch?: boolean }) => {
		if (this.deletingIds.has(s.id)) return;
		this.target = null; // close the confirm modal immediately; cleanup runs in the background
		this.deletingIds.add(s.id);
		// Notify optimistically, before the request lands: the open session's page
		// navigates away here (mirrors mergeCleanup), and the background refresh
		// below reconciles the list once the delete completes.
		this.onDeleted(s);
		try {
			await requestDelete(s.id, opts);
			// Delete succeeded: clear any prior failure, then reconcile the list. A
			// refresh failure is transient (the 5s poll catches up) and must not be
			// reported as a delete failure.
			this.error = null;
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
