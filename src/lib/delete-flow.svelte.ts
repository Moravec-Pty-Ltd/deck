import { SvelteSet } from 'svelte/reactivity';
import type { DeckSession } from '$lib/types';

// Shared session-delete flow for the home list and the session-view sidebar:
// the confirm-modal state, per-id in-flight tracking (deletes run in the
// background so several can be in flight at once, issue #59), and the DELETE
// request with worktree/branch options. `canDelete` lets the session page
// refuse deleting the session being viewed.
export function createDeleteFlow(
	refresh: () => Promise<void>,
	canDelete?: (s: DeckSession) => boolean
) {
	let target = $state<DeckSession | null>(null);
	let worktree = $state(true);
	let branch = $state(true);
	const deletingIds = new SvelteSet<string>();
	let error = $state<string | null>(null);

	function blocked(s: DeckSession): boolean {
		return deletingIds.has(s.id) || canDelete?.(s) === false;
	}

	// Open the confirm modal for a worktree session; plain sessions just get a
	// native confirm and delete straight away.
	function request(s: DeckSession) {
		if (blocked(s)) return;
		if (s.worktree) {
			worktree = true;
			branch = s.worktree.createdBranch;
			target = s;
			return;
		}
		if (confirm(`Kill and remove "${s.title}"?`)) run(s, {});
	}

	async function requestDelete(
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

	async function run(s: DeckSession, opts: { deleteWorktree?: boolean; deleteBranch?: boolean }) {
		if (deletingIds.has(s.id)) return;
		target = null; // close the confirm modal immediately; cleanup runs in the background
		deletingIds.add(s.id);
		try {
			await requestDelete(s.id, opts);
			// Delete succeeded: clear any prior failure, then reconcile the list. A
			// refresh failure is transient (the 5s poll catches up) and must not be
			// reported as a delete failure.
			error = null;
			try {
				await refresh();
			} catch {
				// ignore; the poll will drop the row
			}
		} catch {
			error = `Couldn't remove "${s.title}".`;
		} finally {
			deletingIds.delete(s.id);
		}
	}

	return {
		deletingIds,
		get target() {
			return target;
		},
		set target(v: DeckSession | null) {
			target = v;
		},
		get worktree() {
			return worktree;
		},
		set worktree(v: boolean) {
			worktree = v;
		},
		get branch() {
			return branch;
		},
		set branch(v: boolean) {
			branch = v;
		},
		get error() {
			return error;
		},
		set error(v: string | null) {
			error = v;
		},
		request,
		run
	};
}
