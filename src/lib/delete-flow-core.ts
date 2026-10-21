import type { SessionView } from './session-view';

// Node-free core of the batch delete path, so the sequencing and the failure
// collection are unit-testable apart from the runes in delete-flow.svelte.ts.

// Delete `sessions` one at a time, collecting failures instead of aborting on the
// first one, and reporting after each attempt (settled, not succeeded) so the
// caller can clear the row's spinner and advance its progress bar. Sequential
// because worktree removal shells out to git in the same repo, where concurrent
// removals contend on the repo lock.
export async function deleteSequentially(
	sessions: SessionView[],
	del: (s: SessionView) => Promise<void>,
	onSettled: (s: SessionView, done: number) => void
): Promise<SessionView[]> {
	const failed: SessionView[] = [];
	let done = 0;
	for (const s of sessions) {
		try {
			await del(s);
		} catch {
			failed.push(s);
		}
		onSettled(s, ++done);
	}
	return failed;
}

// The error-alert copy for a finished batch: name the session when one failed,
// count them against the batch when several did. Null when everything went.
export function batchErrorMessage(failed: SessionView[], total: number): string | null {
	if (failed.length === 0) return null;
	if (failed.length === 1) return `Couldn't remove "${failed[0].title}".`;
	return `Couldn't remove ${failed.length} of ${total} sessions.`;
}
