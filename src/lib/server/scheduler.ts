// The scheduler (issue #235): a prompt that runs on a clock. Each tick looks for
// schedules whose stored due time has passed and sends their prompt — into the
// session they name, or into a fresh one spawned in their directory. The pure
// decisions (what is due, what to skip, what body to create with) are
// schedule-core.ts.
//
// A run being due is a numeric comparison against a stored time, not a cron
// expression matched against the current minute. That is what makes a missed
// window fire once rather than once per minute deck was away, and it is why the
// tick can be cheap enough to ride beside the health poll.
import { isAgentKind, type Project } from '$lib/types';
import type { Schedule } from '$lib/schedules';
import { agentTurnRunning } from './agents/dispatch';
import { createSessionFromRequest } from './create-session';
import { getSession } from './sessions';
import { sendAgentMessage } from './send-agent-message';
import { listProjects } from './store';
import { notify } from './push';
import { applyOutcome, createBody, decide, nextDue } from './schedule-core';
import { getSchedule, listSchedules, saveSchedule } from './schedule-store';

// A failure the next window cannot fix: the schedule points at something that is
// no longer there. These switch the schedule off and say so, rather than failing
// silently every window from now on.
class BrokenTarget extends Error {}

// Run now, asked for while the last run is still going. Its own type so the
// route can answer 409 without having to recognise a message.
export class ScheduleBusy extends Error {}

function message(e: unknown): string {
	if (e && typeof e === 'object' && 'body' in e) {
		const body = (e as { body?: { message?: string } }).body;
		if (body?.message) return body.message;
	}
	return e instanceof Error ? e.message : String(e);
}

// The registered project a scheduled directory belongs to, which is what the
// agent fields fall back to for a model. A directory outside the project set is
// still a fine place to run, so stand in a bare record rather than refusing.
function projectFor(cwd: string): Project {
	return listProjects().find((p) => p.path === cwd) ?? { name: cwd, path: cwd };
}

// Whether this schedule's last run is still going. Asked of the agent layer
// rather than of the stored status, so it reflects a turn in flight and not a
// poll that may be ten seconds old.
function isBusy(schedule: Schedule): boolean {
	const id = schedule.sessionId ?? schedule.lastSessionId;
	return !!id && agentTurnRunning(id);
}

// Send the prompt into the session the schedule names. The session keeps what it
// learned last time, which is the whole point of this shape.
async function sendToSession(schedule: Schedule, id: string): Promise<string> {
	const session = await getSession(id);
	if (!session) throw new BrokenTarget('the session this schedule sends to no longer exists');
	if (!isAgentKind(session.kind)) throw new BrokenTarget('the session this schedule sends to is a terminal, not an agent');
	// `expand` so a scheduled prompt can use the same [tokens] a quick message
	// does, against the session it is going to.
	await sendAgentMessage(session, { text: schedule.prompt, expand: true });
	return session.id;
}

// Spawn a fresh session and let its first turn be the prompt, the way an
// automation lane does. `remember: false` for the same reason: a schedule
// running on a cheap local model must not become the manual picker's default.
async function spawnSession(schedule: Schedule): Promise<string> {
	const session = await createSessionFromRequest(createBody(schedule, projectFor(schedule.cwd!)), {
		remember: false
	});
	return session.id;
}

function dispatch(schedule: Schedule): Promise<string> {
	return schedule.sessionId ? sendToSession(schedule, schedule.sessionId) : spawnSession(schedule);
}

// Write an outcome against the schedule as it stands now, not against the copy
// this run started from: a run can outlive an edit, and the edit is the newer
// truth about everything except how the run went.
function record(
	id: string,
	at: number,
	outcome: Parameters<typeof applyOutcome>[2],
	detail: { note?: string; sessionId?: string } = {}
): void {
	const current = getSchedule(id);
	if (!current) return;
	saveSchedule(applyOutcome(current, at, outcome, detail));
}

// A schedule that cannot work again until someone changes it. Switched off so it
// stops failing every window, and pushed once, because a job you believe is
// running and is not is exactly the thing worth interrupting for.
function breakSchedule(schedule: Schedule, reason: string): void {
	const current = getSchedule(schedule.id) ?? schedule;
	saveSchedule({ ...applyOutcome(current, Date.now(), 'failed', { note: reason }), enabled: false });
	notify({
		reason: 'needs-you',
		title: `Schedule stopped · ${schedule.title}`,
		body: reason,
		tag: `schedule:${schedule.id}`,
		url: '/schedules'
	});
}

// Run one schedule now, whatever its due time says. Shared by the tick and the
// Run now button.
async function fire(schedule: Schedule): Promise<void> {
	const at = Date.now();
	// Move the due time on before anything awaits. A crash part-way through a
	// spawn would otherwise leave the window open for the next tick to fire
	// again, which for a session-spawning schedule means two sessions.
	saveSchedule({ ...schedule, nextRunAt: nextDue(schedule, at) });
	try {
		record(schedule.id, at, 'ran', { sessionId: await dispatch(schedule) });
	} catch (e) {
		const reason = message(e);
		console.error(`[deck] schedule ${schedule.id} failed:`, e);
		if (e instanceof BrokenTarget) breakSchedule(schedule, reason);
		else record(schedule.id, at, 'failed', { note: reason });
	}
}

// Re-entrancy guard mirroring the other polls: a slow spawn must not let the
// next tick start an overlapping pass that fires the same window twice.
let polling = false;

// One pass over every schedule. Best-effort and self-guarded, hung on its own
// timer in monitor.ts.
export async function pollSchedules(): Promise<void> {
	if (polling) return;
	polling = true;
	try {
		const now = Date.now();
		// A copy, because firing writes the store back.
		for (const schedule of [...listSchedules()]) {
			// Re-read: an earlier fire in this same pass may have changed it.
			const current = getSchedule(schedule.id);
			if (!current) continue;
			const action = decide(current, now, isBusy(current));
			if (action.act === 'wait') continue;
			if (action.act === 'skip') {
				record(current.id, now, 'skipped', { note: action.note });
				continue;
			}
			await fire(current);
		}
	} finally {
		polling = false;
	}
}

// The Run now button. Refuses while the last run is still going rather than
// starting a second one behind it, and reports that as an error the button can
// show: the person pressing it is owed an answer either way.
export async function runScheduleNow(id: string): Promise<Schedule | undefined> {
	const schedule = getSchedule(id);
	if (!schedule) return undefined;
	if (isBusy(schedule)) throw new ScheduleBusy('the last run is still going');
	await fire(schedule);
	return getSchedule(id);
}
