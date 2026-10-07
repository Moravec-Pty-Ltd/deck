// The scheduler's decisions (issue #235), kept node-free so they unit-test
// without fs, tmux or an agent: validating a schedule from an untyped body,
// working out whether a tick should run one, and building the body a run
// creates its session from. The firing itself is scheduler.ts.
import { z } from 'zod';
import { nextAfter, parseCron } from '$lib/cron';
import type { Schedule, ScheduleOutcome } from '$lib/schedules';
import type { AutomationAgent, Project } from '$lib/types';
import { agentFields, agentSchema } from './automation-core';

// How late a run may be and still happen. Past this, the window is recorded as
// missed and the schedule moves on to the next one.
//
// There has to be a limit, because a stored due time means a laptop that was
// shut for a week comes back with a week-old run outstanding. Nobody opening
// their laptop on Thursday wants Monday's 9am job. An hour is long enough to
// cover a restart, a sleep over lunch, or deck being briefly down, and short
// enough that a run which does happen is still about now.
export const CATCHUP_MS = 60 * 60 * 1000;

// Long enough to tell one schedule from another in a list, short enough to read
// on a phone. Titles name the sessions a schedule spawns, so they are seen far
// more often than they are typed.
const TITLE_CAP = 60;

export class ScheduleError extends Error {}

const scheduleSchema = z
	.object({
		title: z.string().trim().max(200).optional(),
		cron: z.string().trim().min(1, 'a schedule is required'),
		prompt: z.string().min(1, 'a prompt is required'),
		enabled: z.boolean().optional(),
		sessionId: z.string().trim().optional(),
		cwd: z.string().trim().optional(),
		agent: agentSchema.optional()
	})
	// One target, named plainly: the two shapes behave differently enough that
	// guessing which was meant would be worse than asking.
	.refine((s) => !!s.sessionId !== !!s.cwd, {
		message: 'give either a session to send to or a directory to start in, not both'
	});

// The first schema problem as one line, the way the automation form reads them.
function problem(err: z.ZodError): string {
	const issue = err.issues[0];
	if (!issue) return 'invalid schedule';
	return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

// A title for a schedule that was not given one: the prompt's opening words. A
// schedule is mostly described by what it asks for, so this is usually the title
// someone would have typed anyway.
export function titleFrom(prompt: string): string {
	const line = prompt.trim().split('\n')[0].trim();
	if (line.length <= TITLE_CAP) return line || 'Scheduled prompt';
	// Cut at a word boundary where there is one close to the cap, so the title
	// does not end mid-word.
	const cut = line.slice(0, TITLE_CAP);
	const space = cut.lastIndexOf(' ');
	return `${(space > TITLE_CAP - 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// A blank agent pick collapses to absent, so schedules.json stays tidy for the
// common case of not caring which model runs it.
function toAgent(agent: AutomationAgent | undefined): AutomationAgent | undefined {
	if (!agent) return undefined;
	return Object.values(agent).some((v) => v !== undefined) ? agent : undefined;
}

export interface ScheduleInput {
	title: string;
	cron: string;
	prompt: string;
	enabled: boolean;
	sessionId?: string;
	cwd?: string;
	agent?: AutomationAgent;
}

// A schedule from an untyped request body. Throws a ScheduleError with a
// one-line message, which the route turns into a 400.
//
// The cron expression is parsed here rather than at firing time: a schedule that
// cannot be read is one that silently never runs, and the person who typed it is
// standing right there.
export function parseScheduleRequest(raw: unknown): ScheduleInput {
	const parsed = scheduleSchema.safeParse(raw);
	if (!parsed.success) throw new ScheduleError(problem(parsed.error));
	const { title, cron, prompt, enabled, sessionId, cwd, agent } = parsed.data;
	try {
		parseCron(cron);
	} catch (e) {
		throw new ScheduleError(e instanceof Error ? e.message : 'invalid schedule');
	}
	if (!prompt.trim()) throw new ScheduleError('a prompt is required');
	return {
		title: title || titleFrom(prompt),
		cron,
		prompt,
		enabled: enabled ?? true,
		sessionId: sessionId || undefined,
		cwd: cwd || undefined,
		agent: toAgent(agent)
	};
}

// A patch body: every field optional, and only the ones present are applied. A
// stale client must not wipe a field it has never heard of, the same bargain
// parseAutomation makes.
export function parseSchedulePatch(raw: unknown, existing: Schedule): ScheduleInput {
	const body = (raw ?? {}) as Record<string, unknown>;
	const merged = {
		title: 'title' in body ? body.title : existing.title,
		cron: 'cron' in body ? body.cron : existing.cron,
		prompt: 'prompt' in body ? body.prompt : existing.prompt,
		enabled: 'enabled' in body ? body.enabled : existing.enabled,
		agent: 'agent' in body ? body.agent : existing.agent,
		// The target is a pair, so a patch that moves it has to send both halves;
		// one of them on its own would leave a schedule with two targets or none.
		...targetPatch(body, existing)
	};
	return parseScheduleRequest(merged);
}

function targetPatch(body: Record<string, unknown>, existing: Schedule): { sessionId?: unknown; cwd?: unknown } {
	if (!('sessionId' in body) && !('cwd' in body)) {
		return existing.sessionId ? { sessionId: existing.sessionId } : { cwd: existing.cwd };
	}
	// A blank value is how a client clears the half it is moving away from, so
	// read both and let the schema insist on exactly one.
	const sessionId = 'sessionId' in body ? body.sessionId : undefined;
	const cwd = 'cwd' in body ? body.cwd : undefined;
	return { ...(sessionId ? { sessionId } : {}), ...(cwd ? { cwd } : {}) };
}

// What a tick should do about one schedule.
export type ScheduleAction =
	// Not due. Nothing to record.
	| { act: 'wait' }
	// Send the prompt.
	| { act: 'run' }
	// Pass this window over, and say why in the list.
	| { act: 'skip'; note: string };

// Whether this tick runs a schedule, given the clock and whether its last run is
// still going.
//
// `busy` comes from the caller because answering it means reading live session
// state. Skipping on it is unconditional: a job that takes longer than its own
// interval would otherwise start a second copy every tick, and for a schedule
// that spawns a session each run that means a pile of them.
export function decide(schedule: Schedule, now: number, busy: boolean): ScheduleAction {
	if (!schedule.enabled) return { act: 'wait' };
	const due = schedule.nextRunAt;
	if (due === undefined || due > now) return { act: 'wait' };
	// Checked before `busy`, so a window missed over a long outage reads as the
	// outage rather than blaming whatever happens to be running now.
	if (now - due > CATCHUP_MS) return { act: 'skip', note: 'deck was not running at the scheduled time' };
	if (busy) return { act: 'skip', note: 'the previous run was still going' };
	return { act: 'run' };
}

// The schedule's next due time, or undefined for an expression that has no next
// run (29 February is reachable; 30 February is not).
//
// Measured from `now` rather than from the due time just served, so a schedule
// that was down for a day resumes on the next real window instead of walking
// forward through every one it missed.
export function nextDue(schedule: Pick<Schedule, 'cron'>, now: number): number | undefined {
	try {
		return nextAfter(parseCron(schedule.cron), now) ?? undefined;
	} catch {
		return undefined;
	}
}

// Record what a run came to and set the next due time. Returns a new record
// rather than mutating, so a caller cannot half-apply an outcome.
export function applyOutcome(
	schedule: Schedule,
	now: number,
	outcome: ScheduleOutcome,
	detail: { note?: string; sessionId?: string } = {}
): Schedule {
	return {
		...schedule,
		lastRunAt: now,
		lastOutcome: outcome,
		lastNote: detail.note,
		// Kept from the previous run when this one did not reach a session, so the
		// list still links to the last output there was.
		lastSessionId: detail.sessionId ?? schedule.lastSessionId,
		runs: outcome === 'ran' ? schedule.runs + 1 : schedule.runs,
		nextRunAt: nextDue(schedule, now)
	};
}

// The POST /api/sessions body a fresh run creates its session from. The agent
// half is an automation lane's, so an unset model falls back to the project's
// remembered pick and then the CLI's default.
//
// No worktree: a scheduled job runs in the project directory. A branch per run
// would leave a daily schedule trailing a new one every morning, and the jobs
// this is for mostly read.
export function createBody(schedule: Schedule, project: Project): Record<string, unknown> {
	return {
		cwd: schedule.cwd,
		title: schedule.title,
		prompt: schedule.prompt,
		...agentFields(project, schedule.agent)
	};
}
