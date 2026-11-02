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

// Sessions mid-turn. One only waiting on a question is not working, so it gets
// the normal confirm. Mirrored in DeckKit's DeleteWarning.
export function runningSessions(list: SessionView[]): SessionView[] {
	return list.filter((s) => s.status === 'running' && !s.awaitingInput);
}

// The in-progress warning for a delete confirm, null when nothing is working.
export function runningWarning(list: SessionView[]): string | null {
	const running = runningSessions(list);
	if (running.length === 0) return null;
	if (list.length === 1)
		return 'This session is still working. Deleting it stops the current turn and any subagents, and the work in progress is lost.';
	const n = running.length;
	return `${n} of these sessions ${n === 1 ? 'is' : 'are'} still working: ${running.map((s) => s.title).join(', ')}.`;
}

// The confirm button: name the stop when any session is working.
export function deleteLabel(list: SessionView[], plain: string): string {
	if (runningSessions(list).length === 0) return plain;
	return list.length === 1 ? 'Stop and Delete' : `Stop and Delete ${list.length} Sessions`;
}
