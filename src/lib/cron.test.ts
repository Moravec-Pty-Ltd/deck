import { describe, expect, it } from 'vitest';
import { CronError, cronProblem, nextAfter, nextRuns, parseCron } from './cron';

// Local time throughout, because that is what a schedule means by "9am". The
// suite builds its instants with the Date constructor for the same reason, so it
// passes in whatever zone the machine running it is in.
function at(y: number, m: number, d: number, h = 0, min = 0): number {
	return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function iso(ms: number | null): string {
	if (ms === null) return 'never';
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function next(expression: string, from: number): string {
	return iso(nextAfter(parseCron(expression), from));
}

describe('parseCron', () => {
	it('reads every field shape', () => {
		const spec = parseCron('0,30 9-17 1 * *');
		expect([...spec.minute]).toEqual([0, 30]);
		expect([...spec.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect([...spec.dom]).toEqual([1]);
		expect(spec.month.size).toBe(12);
	});

	it('steps a wildcard and a bare start', () => {
		expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
		// A bare number with a step runs to the end of the field, as crontab(5) has it.
		expect([...parseCron('5/15 * * * *').minute]).toEqual([5, 20, 35, 50]);
		expect([...parseCron('0 0-12/4 * * *').hour]).toEqual([0, 4, 8, 12]);
	});

	it('takes month and weekday names', () => {
		expect([...parseCron('0 9 * * mon-fri').dow]).toEqual([1, 2, 3, 4, 5]);
		expect([...parseCron('0 9 * jan,jul *').month]).toEqual([1, 7]);
		expect([...parseCron('0 9 * * SUN').dow]).toEqual([0]);
	});

	// Cron spells Sunday both ways and Date.getDay() only knows one of them.
	it('folds the second spelling of Sunday onto zero', () => {
		expect([...parseCron('0 9 * * 7').dow]).toEqual([0]);
		expect([...parseCron('0 9 * * 0,7').dow]).toEqual([0]);
	});

	it('names the field it could not read', () => {
		expect(() => parseCron('0 9 * *')).toThrow(/expected 5 fields/);
		expect(() => parseCron('60 9 * * *')).toThrow(/minute/);
		expect(() => parseCron('0 24 * * *')).toThrow(/hour/);
		expect(() => parseCron('0 9 0 * *')).toThrow(/day of month/);
		expect(() => parseCron('0 9 * 13 *')).toThrow(/month/);
		expect(() => parseCron('0 9 * * funday')).toThrow(/day of week/);
		expect(() => parseCron('0 9 * * *')).not.toThrow();
	});

	it('rejects a backwards range, a zero step and an empty term', () => {
		expect(() => parseCron('0 17-9 * * *')).toThrow(CronError);
		expect(() => parseCron('*/0 * * * *')).toThrow(CronError);
		expect(() => parseCron('0,,30 * * * *')).toThrow(CronError);
		expect(() => parseCron('0 9 * * 1/2/3')).toThrow(CronError);
	});

	it('reports a problem as one line, or null when there is none', () => {
		expect(cronProblem('0 9 * * *')).toBeNull();
		expect(cronProblem('nope')).toMatch(/expected 5 fields/);
	});
});

describe('nextAfter', () => {
	it('finds the next run later the same day', () => {
		expect(next('0 9 * * *', at(2026, 3, 10, 7, 30))).toBe('2026-03-10 09:00');
	});

	it('rolls to tomorrow once today has passed', () => {
		expect(next('0 9 * * *', at(2026, 3, 10, 9, 1))).toBe('2026-03-11 09:00');
	});

	// Strictly after, so a schedule that just ran on its due minute is not
	// immediately due again — which would fire it every tick.
	it('is strictly after the instant given', () => {
		expect(next('0 9 * * *', at(2026, 3, 10, 9, 0))).toBe('2026-03-11 09:00');
		expect(next('* * * * *', at(2026, 3, 10, 9, 0))).toBe('2026-03-10 09:01');
	});

	it('ignores the seconds on the way in', () => {
		const from = at(2026, 3, 10, 8, 59) + 45_000;
		expect(iso(nextAfter(parseCron('0 9 * * *'), from))).toBe('2026-03-10 09:00');
	});

	it('skips to the next matching weekday', () => {
		// 2026-03-13 is a Friday, so the next weekday run is Monday the 16th.
		expect(next('0 9 * * mon-fri', at(2026, 3, 13, 10, 0))).toBe('2026-03-16 09:00');
	});

	it('crosses a month and a year boundary', () => {
		expect(next('0 9 1 * *', at(2026, 3, 2))).toBe('2026-04-01 09:00');
		expect(next('0 0 1 1 *', at(2026, 6, 1))).toBe('2027-01-01 00:00');
	});

	// Cron's and/or day rule: with both day fields narrowed, either one matching
	// is a match.
	it('ors the two day fields when both are narrowed', () => {
		// March 2026: the 1st is a Sunday, so Mondays are the 2nd, 9th, 16th.
		expect(next('0 9 16 * mon', at(2026, 3, 3))).toBe('2026-03-09 09:00');
		expect(next('0 9 16 * mon', at(2026, 3, 10))).toBe('2026-03-16 09:00');
		// With one of them a wildcard, only the other decides.
		expect(next('0 9 16 * *', at(2026, 3, 3))).toBe('2026-03-16 09:00');
	});

	it('reaches a leap day and gives up on a date that cannot happen', () => {
		expect(next('0 9 29 2 *', at(2026, 3, 1))).toBe('2028-02-29 09:00');
		expect(nextAfter(parseCron('0 9 30 2 *'), at(2026, 3, 1))).toBeNull();
	});

	// 02:30 is the reading on the wall clock, and when clocks go back that reading
	// comes round twice. A daily schedule must still run once that day: this is
	// the test that fails if the walk steps timestamps instead of local fields.
	// It only bites in a zone that observes daylight saving, so it sweeps a year
	// rather than naming a date, and it is worth running under TZ=Australia/Sydney
	// and TZ=America/New_York as well as whatever this machine is in.
	it('runs a daily schedule at most once a day across a clock change', () => {
		const spec = parseCron('30 2 * * *');
		let cursor = at(2026, 1, 1);
		const end = at(2027, 1, 1);
		const days = new Set<string>();
		let runs = 0;
		while (cursor < end) {
			const run = nextAfter(spec, cursor);
			expect(run).not.toBeNull();
			// Every run is later than the one before it, or the scheduler would
			// re-fire the same due time for ever.
			expect(run!).toBeGreaterThan(cursor);
			const d = new Date(run!);
			days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
			runs++;
			cursor = run!;
		}
		expect(days.size).toBe(runs);
		// 365 days, less at most the one a spring-forward can erase 02:30 from.
		expect(runs).toBeGreaterThanOrEqual(364);
		expect(runs).toBeLessThanOrEqual(366);
	});
});

describe('nextRuns', () => {
	it('previews the next few runs in order', () => {
		const runs = nextRuns('0 9 * * *', at(2026, 3, 10, 12, 0), 3).map(iso);
		expect(runs).toEqual(['2026-03-11 09:00', '2026-03-12 09:00', '2026-03-13 09:00']);
	});

	// The form previews as you type, so a half-finished expression has to come
	// back empty rather than throw into the render.
	it('comes back empty for an expression that does not parse or cannot happen', () => {
		expect(nextRuns('0 9 * *', Date.now())).toEqual([]);
		expect(nextRuns('0 9 30 2 *', Date.now())).toEqual([]);
	});
});
