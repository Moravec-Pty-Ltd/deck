// Why `git worktree add` refused, and what can be done about it. Shared by the
// server (which classifies the failure) and the new-session modal (which offers
// the ways out), so the two can't describe the same problem differently.
//
// These are the two states deck leaves behind. A run or session that made a
// branch and then lost its worktree directory leaves `branch-exists`; one whose
// directory was deleted without git being told leaves `stale-worktree`, where
// git still believes the branch is checked out somewhere.

export type WorktreeConflict = 'branch-exists' | 'stale-worktree' | null;

// What a conflict is resolved by. `reuse` checks the existing branch out and
// keeps its commits; `recreate` throws the branch away and starts from the base.
export type WorktreeFix = 'reuse' | 'recreate';

export const WORKTREE_FIXES: readonly WorktreeFix[] = ['reuse', 'recreate'];

export function isWorktreeFix(v: unknown): v is WorktreeFix {
	return typeof v === 'string' && (WORKTREE_FIXES as readonly string[]).includes(v);
}

// Whether an error body's `code` is one of ours, so a 409 from somewhere else
// can't be read as a worktree conflict.
export function isWorktreeConflict(v: unknown): v is Exclude<WorktreeConflict, null> {
	return v === 'branch-exists' || v === 'stale-worktree';
}

// Read git's own wording. Matched loosely (the branch name and path vary, and
// git prefixes with `fatal:`) but specifically enough that an unrelated failure
// falls through to null and is reported as-is rather than offered a fix that
// cannot help.
export function worktreeConflict(message: string): WorktreeConflict {
	const text = message.toLowerCase();
	if (/is already checked out at/.test(text)) return 'stale-worktree';
	if (/a branch named .* already exists/.test(text)) return 'branch-exists';
	return null;
}

// What to tell the user. Says what deck found, not what git printed.
export function conflictMessage(conflict: WorktreeConflict, branch: string): string {
	if (conflict === 'branch-exists') {
		// Deliberately doesn't say whether anything is checked out on it: `git
		// worktree add -b` reports the branch before it reports a stale
		// registration, so both states arrive here and only one of them would be
		// described correctly.
		return `The branch ${branch} already exists. An earlier session or run probably left it behind.`;
	}
	if (conflict === 'stale-worktree') {
		return `Git still has ${branch} checked out in a worktree that is no longer there. Its directory was removed without git being told.`;
	}
	return '';
}

// The label and consequence of each way out, for the buttons that offer them.
export function fixLabel(fix: WorktreeFix): string {
	return fix === 'reuse' ? 'Use the existing branch' : 'Delete it and start fresh';
}

export function fixDetail(fix: WorktreeFix, branch: string): string {
	return fix === 'reuse'
		? `Check ${branch} out as it stands, keeping any commits on it.`
		: `Delete ${branch} and branch again from the base. Commits on it that are not pushed are lost.`;
}
