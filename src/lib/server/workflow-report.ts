// Tells the session that started a run when the run ends (issue #413), in one
// message. A busy session is told when its turn finishes, so the message never
// interrupts it; an idle one is woken.
import { agentFeed, type AgentFeedEvent } from './agent-feed';
import { agentTurnRunning } from './agents/dispatch';
import { sendAgentMessage } from './send-agent-message';
import { baseUrl } from './config';
import { getStoredSession } from './store';
import { isFinished, runReport } from './workflow-core';
import { listRuns, overseerId, saveRun } from './workflow-store';
import { starterSession } from '$lib/workflow-view';
import type { WorkflowRun } from '$lib/workflows';

const starter = (run: WorkflowRun) => starterSession(run)?.sessionId;

// The runs a session started.
export function runsStartedBy(sessionId: string): WorkflowRun[] {
	return listRuns().filter((r) => starter(r) === sessionId);
}

// The run just blocked or finished: owe its starting session a message. The
// overseer already gets its own note.
export function reportRun(run: WorkflowRun): void {
	const id = starter(run);
	if (!id || id === overseerId()) return;
	run.reportDue = true;
	saveRun(run);
	flushReports();
}

function settled(run: WorkflowRun): void {
	run.reportDue = undefined;
	saveRun(run);
}

async function deliver(sessionId: string, runs: WorkflowRun[]): Promise<void> {
	const session = getStoredSession(sessionId);
	const sent = session && sendAgentMessage(session, { text: runs.map((r) => runReport(r, baseUrl)).join('\n\n') });
	// After the send starts, so a crash before it can't lose the report; in the
	// same tick, so a flush landing meanwhile can't send it twice.
	runs.forEach(settled);
	await sent;
}

// Mid-turn, or a phase session of a live run: a message there would start a turn
// in a worktree the run is still working in, and reviewers are never messaged.
function held(sessionId: string): boolean {
	return agentTurnRunning(sessionId) || listRuns().some((r) => !isFinished(r) && r.visits.some((v) => v.sessionId === sessionId));
}

// Send every report whose session is free, one message per session.
export function flushReports(): void {
	const due = new Map<string, WorkflowRun[]>();
	for (const run of listRuns()) {
		if (!run.reportDue) continue;
		const id = starter(run);
		// Resumed or taken over before anyone could be told: no longer an end.
		if (!id || (run.status !== 'blocked' && run.status !== 'done')) settled(run);
		else if (!held(id)) due.set(id, [...(due.get(id) ?? []), run]);
	}
	for (const [id, runs] of due) {
		void deliver(id, runs).catch((e) => console.error(`[deck] run report to ${id} failed:`, e));
	}
}

const g = globalThis as { __deckReportsWired?: boolean };
if (!g.__deckReportsWired) {
	g.__deckReportsWired = true;
	agentFeed.on('event', (event: AgentFeedEvent) => {
		// Also on status: a non-claude turn can still count as running when its
		// turn-finished lands. And a run ending frees its phase sessions.
		if (event.type === 'turn-finished' || event.type === 'status' || event.type === 'run-updated') flushReports();
	});
}
