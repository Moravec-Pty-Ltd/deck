// The scheduler (issue #235): a prompt, a cron expression, and somewhere to send
// it. These are the shapes shared by the server, the web UI and the agent API
// the iOS app talks to; the due/skip decisions live in server/schedule-core.ts
// and the firing in server/scheduler.ts.
import type { AutomationAgent } from './types';

// What became of the last run, which is the one thing the list has to say
// honestly: a schedule that stopped working should look different from one that
// has not come round yet.
export type ScheduleOutcome =
	// The prompt went to an agent.
	| 'ran'
	// Deliberately passed over: the previous run was still going, or the window
	// went by while deck was down. The schedule is healthy.
	| 'skipped'
	// Something was wrong — a session that no longer exists, a directory that
	// does not. The reason is in `lastError`.
	| 'failed';

export interface Schedule {
	id: string;
	title: string;
	// Five fields, read in the deck machine's local time. See $lib/cron.
	cron: string;
	prompt: string;
	// Off keeps the schedule and stops it running. Deck also switches this off by
	// itself when a run fails for a reason retrying cannot fix.
	enabled: boolean;
	// Where each run goes, and the one real choice in a schedule.
	//
	// `sessionId` sends the prompt into a session that already exists, so what it
	// learned on the last run is still there on the next one. That is the shape
	// you get by extending an existing session into a schedule, and it is the one
	// to pick when the job builds on itself.
	//
	// `cwd` spawns a fresh session per run instead, in that directory, with the
	// agent chosen below. Nothing carries over, which is what you want for a job
	// that should look at the world as it is each time.
	//
	// Exactly one of the two is set.
	sessionId?: string;
	cwd?: string;
	// Which agent a fresh session starts. Unset fields fall back to the project's
	// remembered pick and then the CLI default, the same as an automation lane.
	// Ignored when the target is an existing session, which is already running an
	// agent of its own.
	agent?: AutomationAgent;
	createdAt: number;
	// When this is next due. Stored rather than recomputed from the clock, so a
	// window that went by while deck was down fires once instead of once per
	// minute it was away.
	nextRunAt?: number;
	lastRunAt?: number;
	lastOutcome?: ScheduleOutcome;
	// Why the last run did not go to plan. Carried for 'skipped' as well as
	// 'failed', because "the last run was still going" is worth reading.
	lastNote?: string;
	// The session the last run went to, so the list can link straight to it.
	lastSessionId?: string;
	// How many runs have actually gone to an agent. Skips do not count.
	runs: number;
}

// A schedule as the clients read it: the record, plus the names behind the ids
// that the server is better placed to resolve than either client is.
export interface ScheduleDigest extends Schedule {
	// The target session's title, when the target is a session and it still
	// exists. Absent means it is gone, which is why the schedule stopped.
	sessionTitle?: string;
	// The registered project the cwd belongs to, for a readable target.
	projectName?: string;
}

export const OUTCOME_VIEW: Record<ScheduleOutcome, { label: string; tone: 'ok' | 'muted' | 'bad' }> = {
	ran: { label: 'Ran', tone: 'ok' },
	skipped: { label: 'Skipped', tone: 'muted' },
	failed: { label: 'Failed', tone: 'bad' }
};
