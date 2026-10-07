import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DeckSession, Project } from '$lib/types';
import type { Schedule } from '$lib/schedules';

// Firing is orchestration, not pure logic: the due time has to move on *before*
// the dispatch awaits, a vanished target has to switch the schedule off rather
// than fail every window for ever, and a run that is still going has to be left
// alone. None of that shows up in the schedule-core unit tests, so drive
// pollSchedules over a faked store, session layer and agent.
const fake = vi.hoisted(() => ({
	schedules: [] as Schedule[],
	sessions: [] as DeckSession[],
	projects: [] as Project[],
	created: [] as Record<string, unknown>[],
	sent: [] as { id: string; body: Record<string, unknown> }[],
	notified: [] as Record<string, unknown>[],
	running: new Set<string>(),
	// Due times seen by the store at the moment each dispatch began, which is how
	// the "advanced before awaiting" guarantee is checked.
	dueAtDispatch: [] as (number | undefined)[],
	failCreate: '' as string
}));

vi.mock('./schedule-store', () => ({
	newScheduleId: () => `sch_${fake.schedules.length + 1}`,
	listSchedules: () => fake.schedules,
	getSchedule: (id: string) => fake.schedules.find((s) => s.id === id),
	saveSchedule: (schedule: Schedule) => {
		const i = fake.schedules.findIndex((s) => s.id === schedule.id);
		if (i === -1) fake.schedules.push(schedule);
		else fake.schedules[i] = schedule;
	},
	removeSchedule: () => true
}));
vi.mock('./store', () => ({ listProjects: () => fake.projects }));
vi.mock('./sessions', () => ({
	getSession: async (id: string) => fake.sessions.find((s) => s.id === id)
}));
vi.mock('./agents/dispatch', () => ({ agentTurnRunning: (id: string) => fake.running.has(id) }));
vi.mock('./push', () => ({ notify: (p: Record<string, unknown>) => fake.notified.push(p) }));
vi.mock('./create-session', () => ({
	createSessionFromRequest: async (body: Record<string, unknown>) => {
		fake.dueAtDispatch.push(fake.schedules[0]?.nextRunAt);
		if (fake.failCreate) throw new Error(fake.failCreate);
		fake.created.push(body);
		return { id: `c_${fake.created.length}` };
	}
}));
vi.mock('./send-agent-message', () => ({
	sendAgentMessage: async (session: DeckSession, body: Record<string, unknown>) => {
		fake.dueAtDispatch.push(fake.schedules[0]?.nextRunAt);
		fake.sent.push({ id: session.id, body });
	}
}));

const { pollSchedules, runScheduleNow } = await import('./scheduler');
const { CATCHUP_MS } = await import('./schedule-core');

const PROJECT: Project = { name: 'example', path: '/path/to/example' };

function session(over: Partial<DeckSession> = {}): DeckSession {
	return {
		id: 'c_live',
		kind: 'claude',
		title: 'Standing session',
		cwd: PROJECT.path,
		createdAt: 0,
		lastActiveAt: 0,
		status: 'idle',
		...over
	};
}

// Due a minute ago by default, so a plain tick fires it.
function schedule(over: Partial<Schedule> = {}): Schedule {
	return {
		id: 'sch_1',
		title: 'Morning sweep',
		cron: '*/30 * * * *',
		prompt: 'Summarise what changed overnight.',
		enabled: true,
		cwd: PROJECT.path,
		createdAt: 0,
		runs: 0,
		nextRunAt: Date.now() - 60_000,
		...over
	};
}

const only = () => fake.schedules[0];

beforeEach(() => {
	fake.schedules = [];
	fake.sessions = [session()];
	fake.projects = [PROJECT];
	fake.created = [];
	fake.sent = [];
	fake.notified = [];
	fake.running = new Set();
	fake.dueAtDispatch = [];
	fake.failCreate = '';
});

describe('pollSchedules', () => {
	it('spawns a session for a due schedule and records the run', async () => {
		fake.schedules = [schedule()];
		await pollSchedules();
		expect(fake.created).toHaveLength(1);
		expect(fake.created[0]).toMatchObject({
			cwd: PROJECT.path,
			title: 'Morning sweep',
			prompt: 'Summarise what changed overnight.'
		});
		expect(only()).toMatchObject({ runs: 1, lastOutcome: 'ran', lastSessionId: 'c_1' });
	});

	it('sends into the session a schedule names, rather than making another', async () => {
		fake.schedules = [schedule({ cwd: undefined, sessionId: 'c_live' })];
		await pollSchedules();
		expect(fake.created).toHaveLength(0);
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).toMatchObject({
			id: 'c_live',
			body: { text: 'Summarise what changed overnight.', expand: true }
		});
		expect(only()).toMatchObject({ runs: 1, lastOutcome: 'ran', lastSessionId: 'c_live' });
	});

	// The guarantee that stops a crash part-way through a spawn re-firing the
	// same window on the next tick, which would mean two sessions.
	it('moves the due time on before the dispatch can await', async () => {
		const due = Date.now() - 60_000;
		fake.schedules = [schedule({ nextRunAt: due })];
		await pollSchedules();
		expect(fake.dueAtDispatch).toHaveLength(1);
		expect(fake.dueAtDispatch[0]).toBeGreaterThan(Date.now());
	});

	it('leaves a schedule alone until it is due', async () => {
		fake.schedules = [schedule({ nextRunAt: Date.now() + 60_000 })];
		await pollSchedules();
		expect(fake.created).toHaveLength(0);
		expect(only().lastOutcome).toBeUndefined();
	});

	it('leaves a paused schedule alone', async () => {
		fake.schedules = [schedule({ enabled: false })];
		await pollSchedules();
		expect(fake.created).toHaveLength(0);
	});

	// A job slower than its own interval must not start a second copy, which for
	// a spawning schedule means a pile of sessions.
	it('skips while the last run is still going', async () => {
		fake.schedules = [schedule({ lastSessionId: 'c_old' })];
		fake.running.add('c_old');
		await pollSchedules();
		expect(fake.created).toHaveLength(0);
		expect(only()).toMatchObject({ lastOutcome: 'skipped', lastNote: 'the previous run was still going' });
		// And the window still moves on, so it is not stuck on the old one.
		expect(only().nextRunAt).toBeGreaterThan(Date.now());
	});

	it('skips a window missed while deck was down', async () => {
		fake.schedules = [schedule({ nextRunAt: Date.now() - CATCHUP_MS - 60_000 })];
		await pollSchedules();
		expect(fake.created).toHaveLength(0);
		expect(only()).toMatchObject({
			lastOutcome: 'skipped',
			lastNote: 'deck was not running at the scheduled time'
		});
		expect(only().nextRunAt).toBeGreaterThan(Date.now());
	});

	// A schedule pointed at a session that has been deleted can never work
	// again, so it says so once instead of failing silently every half hour.
	it('switches a schedule off and pushes when its session has gone', async () => {
		fake.schedules = [schedule({ cwd: undefined, sessionId: 'c_deleted' })];
		await pollSchedules();
		expect(only()).toMatchObject({ enabled: false, lastOutcome: 'failed' });
		expect(only().lastNote).toMatch(/no longer exists/);
		expect(fake.notified).toHaveLength(1);
		expect(fake.notified[0]).toMatchObject({ reason: 'needs-you', url: '/schedules' });
	});

	it('switches a schedule off when its session is a terminal', async () => {
		fake.sessions = [session({ id: 's_term', kind: 'shell' })];
		fake.schedules = [schedule({ cwd: undefined, sessionId: 's_term' })];
		await pollSchedules();
		expect(only()).toMatchObject({ enabled: false, lastOutcome: 'failed' });
		expect(only().lastNote).toMatch(/terminal/);
	});

	// A git or worktree hiccup is not a reason to stop: the next window should
	// try again, so the schedule stays on and only the outcome is recorded.
	it('records a transient failure without switching the schedule off', async () => {
		fake.failCreate = 'git is busy';
		fake.schedules = [schedule()];
		await pollSchedules();
		expect(only()).toMatchObject({ enabled: true, lastOutcome: 'failed', lastNote: 'git is busy' });
		expect(only().nextRunAt).toBeGreaterThan(Date.now());
		expect(fake.notified).toHaveLength(0);
	});

	it('runs several due schedules in one pass', async () => {
		fake.schedules = [schedule(), schedule({ id: 'sch_2', title: 'Second' })];
		await pollSchedules();
		expect(fake.created).toHaveLength(2);
		expect(fake.schedules.map((s) => s.lastOutcome)).toEqual(['ran', 'ran']);
	});

	// A fresh run reads the project's remembered pick, the same fallback an
	// automation lane uses.
	it('starts a fresh session on the project’s remembered model', async () => {
		fake.projects = [{ ...PROJECT, lastModels: { claude: { model: 'opus' } } }];
		fake.schedules = [schedule()];
		await pollSchedules();
		expect(fake.created[0]).toMatchObject({ kind: 'claude', model: 'opus' });
	});
});

describe('runScheduleNow', () => {
	it('runs whatever the due time says, and whether or not it is paused', async () => {
		fake.schedules = [schedule({ enabled: false, nextRunAt: Date.now() + 86_400_000 })];
		const after = await runScheduleNow('sch_1');
		expect(fake.created).toHaveLength(1);
		expect(after).toMatchObject({ runs: 1, lastOutcome: 'ran' });
		// Still paused: pressing the button runs it once, it does not turn it on.
		expect(after?.enabled).toBe(false);
	});

	// The person pressing the button is owed an answer, so this is an error the
	// route turns into a 409 rather than a silent no-op.
	it('refuses while the last run is still going', async () => {
		fake.schedules = [schedule({ lastSessionId: 'c_old' })];
		fake.running.add('c_old');
		await expect(runScheduleNow('sch_1')).rejects.toThrow(/still going/);
		expect(fake.created).toHaveLength(0);
	});

	it('comes back empty for a schedule that is not there', async () => {
		expect(await runScheduleNow('sch_nope')).toBeUndefined();
	});
});
