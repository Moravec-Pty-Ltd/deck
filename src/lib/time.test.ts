import { describe, expect, it } from 'vitest';
import { clockTime, whenDue } from './time';

// Local time throughout: a schedule means a reading on the wall clock.
function at(y: number, m: number, d: number, h = 0, min = 0): number {
	return new Date(y, m - 1, d, h, min).getTime();
}

describe('clockTime', () => {
	it('reads a 12-hour clock with am and pm', () => {
		expect(clockTime(at(2026, 3, 10, 9, 0))).toBe('9:00am');
		expect(clockTime(at(2026, 3, 10, 18, 5))).toBe('6:05pm');
	});

	// Both ends of the day are the ones a 12-hour clock gets wrong.
	it('calls midnight 12am and noon 12pm', () => {
		expect(clockTime(at(2026, 3, 10, 0, 0))).toBe('12:00am');
		expect(clockTime(at(2026, 3, 10, 12, 0))).toBe('12:00pm');
		expect(clockTime(at(2026, 3, 10, 0, 30))).toBe('12:30am');
	});
});

describe('whenDue', () => {
	const now = at(2026, 3, 10, 12, 0); // a Tuesday

	it('gives the time alone for today', () => {
		expect(whenDue(at(2026, 3, 10, 18, 0), now)).toBe('6:00pm');
	});

	it('names tomorrow and the weekday after that', () => {
		expect(whenDue(at(2026, 3, 11, 9, 0), now)).toBe('9:00am tomorrow');
		expect(whenDue(at(2026, 3, 13, 9, 0), now)).toBe('9:00am Fri');
	});

	it('falls back to a date once a week out', () => {
		expect(whenDue(at(2026, 4, 1, 9, 0), now)).toMatch(/^9:00am \d/);
	});

	// Counted in calendar days, so an overnight run reads as tomorrow even
	// though it is only an hour or two away.
	it('calls 1am tomorrow tomorrow', () => {
		expect(whenDue(at(2026, 3, 11, 1, 0), at(2026, 3, 10, 23, 30))).toBe('1:00am tomorrow');
	});

	it('shows a time already past as just a time', () => {
		expect(whenDue(at(2026, 3, 9, 9, 0), now)).toBe('9:00am');
	});
});
