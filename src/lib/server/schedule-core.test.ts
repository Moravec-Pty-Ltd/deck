import { describe, expect, it } from 'vitest';
import {
	CATCHUP_MS,
	applyOutcome,
	createBody,
	decide,
	nextDue,
	parseScheduleRequest,
	parseSchedulePatch,
	titleFrom
} from './schedule-core';
import type { Schedule } from '$lib/schedules';
import type { Project } from '$lib/types';

const PROJECT: Project = { name: 'example', path: '/path/to/example' };

function schedule(over: Partial<Schedule> = {}): Schedule {
	return {
		id: 'sch_test',
		title: 'Morning sweep',
		cron: '0 9 * * *',
		prompt: 'Summarise what changed overnight.',
		enabled: true,
		cwd: PROJECT.path,
		createdAt: 0,
		runs: 0,
		...over
	};
}

describe('parseScheduleRequest', () => {
	it('takes a directory target', () => {
		const parsed = parseScheduleRequest({ cron: '0 9 * * *', prompt: 'go', cwd: '/path/to/example' });
		expect(parsed).toMatchObject({ cron: '0 9 * * *', prompt: 'go', cwd: '/path/to/example', enabled: true });
		expect(parsed.sessionId).toBeUndefined();
	});

	it('takes a session target', () => {
		const parsed = parseScheduleRequest({ cron: '0 9 * * *', prompt: 'go', sessionId: 'c_abc' });
		expect(parsed.sessionId).toBe('c_abc');
		expect(parsed.cwd).toBeUndefined();
	});

	// The two targets behave differently enough that guessing would be worse
	// than asking, so neither and both are rejected the same way.
	it('insists on exactly one target', () => {
		expect(() => parseScheduleRequest({ cron: '0 9 * * *', prompt: 'go' })).toThrow(/either a session/);
		expect(() =>
			parseScheduleRequest({ cron: '0 9 * * *', prompt: 'go', cwd: '/x', sessionId: 'c_abc' })
		).toThrow(/either a session/);
	});

	// A schedule whose expression cannot be read is one that silently never
	// runs, so it is rejected while the person who typed it is still there.
	it('rejects an expression it cannot read', () => {
		expect(() => parseScheduleRequest({ cron: 'every morning', prompt: 'go', cwd: '/x' })).toThrow(
			/expected 5 fields/
		);
		expect(() => parseScheduleRequest({ cron: '0 99 * * *', prompt: 'go', cwd: '/x' })).toThrow(/hour/);
	});

	it('requires a prompt with something in it', () => {
		expect(() => parseScheduleRequest({ cron: '0 9 * * *', prompt: '', cwd: '/x' })).toThrow(/prompt/);
		expect(() => parseScheduleRequest({ cron: '0 9 * * *', prompt: '   \n ', cwd: '/x' })).toThrow(/prompt/);
	});

	it('falls back to the prompt for a title', () => {
		const parsed = parseScheduleRequest({ cron: '0 9 * * *', prompt: 'Check the deploy\nthen report', cwd: '/x' });
		expect(parsed.title).toBe('Check the deploy');
	});

	it('keeps an agent pick and drops an empty one', () => {
		expect(parseScheduleRequest({ cron: '0 9 * * *', prompt: 'go', cwd: '/x', agent: { kind: 'codex' } }).agent)
			.toEqual({ kind: 'codex', model: undefined, provider: undefined, effort: undefined });
		expect(parseScheduleRequest({ cron: '0 9 * * *', prompt: 'go', cwd: '/x', agent: {} }).agent).toBeUndefined();
	});

	// Borrowed from the automation lane, so the two cannot drift.
	it('holds the per-kind agent contracts', () => {
		expect(() =>
			parseScheduleRequest({ cron: '0 9 * * *', prompt: 'go', cwd: '/x', agent: { kind: 'codex', effort: 'high' } })
		).toThrow(/effort is only valid for claude/);
		expect(() =>
			parseScheduleRequest({ cron: '0 9 * * *', prompt: 'go', cwd: '/x', agent: { kind: 'claude', provider: 'x' } })
		).toThrow(/provider is only valid for pi/);
	});
});

describe('parseSchedulePatch', () => {
	it('applies only the fields the body mentions', () => {
		const patched = parseSchedulePatch({ enabled: false }, schedule());
		expect(patched).toMatchObject({
			enabled: false,
			title: 'Morning sweep',
			cron: '0 9 * * *',
			prompt: 'Summarise what changed overnight.',
			cwd: PROJECT.path
		});
	});

	// A stale tab posting a body it wrote before a field existed must not wipe
	// that field, the same bargain the automation form makes.
	it('carries a target the body says nothing about', () => {
		expect(parseSchedulePatch({ cron: '0 7 * * *' }, schedule({ cwd: undefined, sessionId: 'c_abc' }))).toMatchObject({
			sessionId: 'c_abc',
			cron: '0 7 * * *'
		});
	});

	it('moves the target from one shape to the other', () => {
		expect(parseSchedulePatch({ sessionId: 'c_abc' }, schedule()).cwd).toBeUndefined();
		expect(parseSchedulePatch({ cwd: '/path/to/other' }, schedule({ cwd: undefined, sessionId: 'c_abc' }))).toMatchObject({
			cwd: '/path/to/other',
			sessionId: undefined
		});
	});

	it('still validates what it is handed', () => {
		expect(() => parseSchedulePatch({ cron: 'nope' }, schedule())).toThrow(/expected 5 fields/);
	});
});

describe('decide', () => {
	const due = 1_000_000;

	it('waits until the due time', () => {
		expect(decide(schedule({ nextRunAt: due }), due - 1, false)).toEqual({ act: 'wait' });
		expect(decide(schedule({ nextRunAt: due }), due, false)).toEqual({ act: 'run' });
	});

	it('waits on a schedule that is switched off', () => {
		expect(decide(schedule({ nextRunAt: due, enabled: false }), due + 1, false)).toEqual({ act: 'wait' });
	});

	it('waits on a schedule with no due time rather than running it', () => {
		expect(decide(schedule({ nextRunAt: undefined }), due, false)).toEqual({ act: 'wait' });
	});

	// A job slower than its own interval would otherwise start a second copy
	// every tick, and for a spawning schedule that is a pile of sessions.
	it('skips while the previous run is still going', () => {
		expect(decide(schedule({ nextRunAt: due }), due, true)).toEqual({
			act: 'skip',
			note: 'the previous run was still going'
		});
	});

	// Opening the laptop on Thursday should not run Monday's 9am job.
	it('skips a window missed by more than the catch-up window', () => {
		expect(decide(schedule({ nextRunAt: due }), due + CATCHUP_MS, false)).toEqual({ act: 'run' });
		expect(decide(schedule({ nextRunAt: due }), due + CATCHUP_MS + 1, false)).toEqual({
			act: 'skip',
			note: 'deck was not running at the scheduled time'
		});
	});

	// Reported as the outage, not as whatever happens to be running now.
	it('blames the outage rather than the running turn when both apply', () => {
		expect(decide(schedule({ nextRunAt: due }), due + CATCHUP_MS + 1, true).act).toBe('skip');
		expect(decide(schedule({ nextRunAt: due }), due + CATCHUP_MS + 1, true)).toMatchObject({
			note: 'deck was not running at the scheduled time'
		});
	});
});

describe('nextDue', () => {
	it('reads the next window off the expression', () => {
		const from = new Date(2026, 2, 10, 7, 0).getTime();
		expect(nextDue({ cron: '0 9 * * *' }, from)).toBe(new Date(2026, 2, 10, 9, 0).getTime());
	});

	it('comes back undefined for an expression with no next run', () => {
		expect(nextDue({ cron: '0 9 30 2 *' }, Date.now())).toBeUndefined();
		expect(nextDue({ cron: 'rubbish' }, Date.now())).toBeUndefined();
	});
});

describe('applyOutcome', () => {
	const at = new Date(2026, 2, 10, 9, 0).getTime();
	const tomorrow = new Date(2026, 2, 11, 9, 0).getTime();

	it('counts a run and moves the due time on', () => {
		const after = applyOutcome(schedule({ nextRunAt: at }), at, 'ran', { sessionId: 'c_new' });
		expect(after).toMatchObject({ runs: 1, lastOutcome: 'ran', lastSessionId: 'c_new', nextRunAt: tomorrow });
	});

	it('does not count a skip or a failure as a run', () => {
		expect(applyOutcome(schedule({ runs: 4 }), at, 'skipped', { note: 'busy' })).toMatchObject({
			runs: 4,
			lastOutcome: 'skipped',
			lastNote: 'busy'
		});
		expect(applyOutcome(schedule({ runs: 4 }), at, 'failed', { note: 'gone' }).runs).toBe(4);
	});

	// The list links to the last output there was, so a skipped window must not
	// erase the session the run before it produced.
	it('keeps the previous session when a run never reached one', () => {
		const after = applyOutcome(schedule({ lastSessionId: 'c_old' }), at, 'skipped', { note: 'busy' });
		expect(after.lastSessionId).toBe('c_old');
	});

	it('leaves the record it was handed alone', () => {
		const before = schedule({ runs: 2 });
		applyOutcome(before, at, 'ran', { sessionId: 'c_new' });
		expect(before.runs).toBe(2);
		expect(before.lastOutcome).toBeUndefined();
	});
});

describe('createBody', () => {
	it('builds a session create body with the schedule title and prompt', () => {
		expect(createBody(schedule(), PROJECT)).toMatchObject({
			cwd: PROJECT.path,
			title: 'Morning sweep',
			prompt: 'Summarise what changed overnight.',
			kind: 'claude'
		});
	});

	it('takes the project’s remembered pick when the schedule names no model', () => {
		const project: Project = { ...PROJECT, lastModels: { claude: { model: 'opus' } }, lastEffort: 'high' };
		expect(createBody(schedule(), project)).toMatchObject({ model: 'opus', effort: 'high' });
	});

	it('prefers the schedule’s own pick', () => {
		const project: Project = { ...PROJECT, lastModels: { claude: { model: 'opus' } } };
		expect(createBody(schedule({ agent: { kind: 'claude', model: 'haiku' } }), project)).toMatchObject({
			kind: 'claude',
			model: 'haiku'
		});
	});

	// A branch per run would leave a daily schedule trailing a new one every
	// morning, so there is deliberately no worktree in the body.
	it('asks for no worktree', () => {
		expect(createBody(schedule(), PROJECT).worktree).toBeUndefined();
	});
});

describe('titleFrom', () => {
	it('uses the first line', () => {
		expect(titleFrom('Check the deploy\nand the logs')).toBe('Check the deploy');
	});

	it('cuts a long line at a word boundary', () => {
		const title = titleFrom('a'.repeat(20) + ' ' + 'b'.repeat(80));
		expect(title.endsWith('…')).toBe(true);
		expect(title.length).toBeLessThanOrEqual(61);
	});

	it('has something to say about an empty prompt', () => {
		expect(titleFrom('   ')).toBe('Scheduled prompt');
	});
});
