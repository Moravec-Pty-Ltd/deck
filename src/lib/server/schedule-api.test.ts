import { describe, expect, it, vi, beforeEach } from 'vitest';
import { thrownError } from './test-env';
import type { DeckSession, Project } from '$lib/types';
import type { Schedule } from '$lib/schedules';

// The HTTP boundary's own rules, which the pure core cannot check: a target has
// to name something that is really there, and the digest has to resolve the ids
// behind a schedule into names. Both reach the session store and the filesystem,
// so they are driven over fakes here rather than through a live server.
const fake = vi.hoisted(() => ({
	sessions: [] as DeckSession[],
	projects: [] as Project[],
	dirs: new Set<string>()
}));

vi.mock('./store', () => ({
	getStoredSession: (id: string) => fake.sessions.find((s) => s.id === id),
	listProjects: () => fake.projects
}));
// Only the id generator is wanted from the store; stubbing it also keeps
// config.ts, which makes directories under ~/.deck at import time, out of the
// way of a test that has no business touching the data directory.
vi.mock('./schedule-store', () => ({ newScheduleId: () => 'sch_new' }));
vi.mock('node:fs', () => ({
	default: { existsSync: (p: string) => fake.dirs.has(p), mkdirSync: vi.fn(), readFileSync: () => '', writeFileSync: vi.fn() }
}));

const { applyPatch, digest, scheduleFromRequest } = await import('./schedule-api');

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

function stored(over: Partial<Schedule> = {}): Schedule {
	return {
		id: 'sch_1',
		title: 'Morning sweep',
		cron: '0 9 * * *',
		prompt: 'Summarise what changed overnight.',
		enabled: true,
		cwd: PROJECT.path,
		createdAt: 0,
		runs: 0,
		nextRunAt: 1_000,
		...over
	};
}

beforeEach(() => {
	fake.sessions = [session()];
	fake.projects = [PROJECT];
	fake.dirs = new Set([PROJECT.path, '/home/someone/notes']);
});

describe('scheduleFromRequest', () => {
	it('builds a schedule already booked for its first window', () => {
		const schedule = scheduleFromRequest({ cron: '0 9 * * *', prompt: 'go', cwd: PROJECT.path });
		expect(schedule).toMatchObject({ cron: '0 9 * * *', prompt: 'go', cwd: PROJECT.path, runs: 0 });
		expect(schedule.id).toMatch(/^sch_/);
		expect(schedule.nextRunAt).toBeGreaterThan(Date.now());
	});

	// A path typo should fail in the form, not silently at 9am tomorrow.
	it('refuses a directory that is not there', () => {
		expect(thrownError(() => scheduleFromRequest({ cron: '0 9 * * *', prompt: 'go', cwd: '/nope' }))).toEqual({
			status: 400,
			message: 'that directory does not exist'
		});
	});

	it('takes a directory outside the registered projects', () => {
		expect(scheduleFromRequest({ cron: '0 9 * * *', prompt: 'go', cwd: '/home/someone/notes' }).cwd).toBe(
			'/home/someone/notes'
		);
	});

	// Checked here rather than at the first window, so the schedule never gets
	// as far as switching itself off over a typo.
	it('refuses a session that does not exist, or cannot take a prompt', () => {
		expect(thrownError(() => scheduleFromRequest({ cron: '0 9 * * *', prompt: 'go', sessionId: 'c_nope' }))).toEqual({
			status: 400,
			message: 'that session does not exist'
		});
		fake.sessions = [session({ id: 's_term', kind: 'shell' })];
		expect(thrownError(() => scheduleFromRequest({ cron: '0 9 * * *', prompt: 'go', sessionId: 's_term' }))).toEqual({
			status: 400,
			message: 'a terminal session cannot take a prompt'
		});
	});

	it('passes a core problem through as a 400 with its own message', () => {
		expect(thrownError(() => scheduleFromRequest({ cron: 'nope', prompt: 'go', cwd: PROJECT.path }))).toMatchObject({
			status: 400,
			message: expect.stringMatching(/expected 5 fields/)
		});
	});

	it('accepts a session target that is a live agent', () => {
		expect(scheduleFromRequest({ cron: '0 9 * * *', prompt: 'go', sessionId: 'c_live' })).toMatchObject({
			sessionId: 'c_live',
			cwd: undefined
		});
	});
});

describe('applyPatch', () => {
	it('keeps the id, creation time and tally', () => {
		const patched = applyPatch(stored({ runs: 7, createdAt: 123 }), { prompt: 'something else' });
		expect(patched).toMatchObject({ id: 'sch_1', createdAt: 123, runs: 7, prompt: 'something else' });
	});

	// An edit should take effect at the next window the new expression names,
	// not at the one the old expression had already booked.
	it('re-books when the expression changes', () => {
		const patched = applyPatch(stored(), { cron: '*/15 * * * *' });
		expect(patched.nextRunAt).toBeGreaterThan(Date.now());
	});

	it('leaves the booking alone when the expression has not changed', () => {
		expect(applyPatch(stored(), { prompt: 'something else' }).nextRunAt).toBe(1_000);
	});

	// The due time a paused schedule carries is from before it was paused, so
	// it is almost certainly in the past and would fire the moment it came back.
	it('re-books when a paused schedule is switched on', () => {
		const patched = applyPatch(stored({ enabled: false, nextRunAt: 1_000 }), { enabled: true });
		expect(patched.nextRunAt).toBeGreaterThan(Date.now());
	});

	it('does not re-book when switching one off', () => {
		expect(applyPatch(stored(), { enabled: false }).nextRunAt).toBe(1_000);
	});

	it('validates the target it is moved to', () => {
		expect(thrownError(() => applyPatch(stored(), { sessionId: 'c_nope' }))).toMatchObject({ status: 400 });
	});
});

describe('digest', () => {
	it('names the project behind a directory', () => {
		expect(digest(stored())).toMatchObject({ projectName: 'example', sessionTitle: undefined });
	});

	it('leaves the project name off a directory no project owns', () => {
		expect(digest(stored({ cwd: '/home/someone/notes' })).projectName).toBeUndefined();
	});

	it('names the session behind a session target', () => {
		expect(digest(stored({ cwd: undefined, sessionId: 'c_live' })).sessionTitle).toBe('Standing session');
	});

	// Absence is the signal the UI reads to say why a schedule stopped, so it
	// has to stay absent rather than become a placeholder.
	it('says nothing for a session that has gone', () => {
		expect(digest(stored({ cwd: undefined, sessionId: 'c_deleted' })).sessionTitle).toBeUndefined();
	});
});
