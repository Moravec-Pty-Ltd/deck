import { describe, it, expect } from 'vitest';
import { shift1d } from './dismiss';

// A 375px-wide viewport with an 8px edge margin: the usable slot is [8, 367].
const MIN = 8;
const MAX = 367;

describe('shift1d', () => {
	it('leaves a fully-visible interval untouched', () => {
		expect(shift1d(10, 100, MIN, MAX)).toBe(0);
	});

	it('does not shift an interval flush against both edges', () => {
		expect(shift1d(MIN, MAX, MIN, MAX)).toBe(0);
	});

	it('pushes a left-overflowing interval right (the dropdown-end repro)', () => {
		// dropdown-end opened from a left-positioned trigger runs past the left edge.
		expect(shift1d(-30, 226, MIN, MAX)).toBe(38); // start -30 -> 8
	});

	it('pulls a right-overflowing interval back left', () => {
		expect(shift1d(300, 400, MIN, MAX)).toBe(-33); // end 400 -> 367
	});

	it('pins the start to min when the interval is wider than the slot', () => {
		// After width capping this should not happen, but keep the leading edge
		// visible rather than centring the clip.
		expect(shift1d(0, 400, MIN, MAX)).toBe(MIN); // 8 - 0
	});

	it('works on the vertical axis the same way', () => {
		// e.g. a tall dropdown-top running off the top of a 640px viewport.
		expect(shift1d(-20, 300, MIN, 632)).toBe(28);
	});
});
