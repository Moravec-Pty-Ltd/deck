import { describe, expect, it } from 'vitest';
import { FITTED, MAX_SCALE, STEP_SCALE, clampView, toggleZoom, wheelFactor, zoomAt } from './zoom-core';

const stage = { w: 800, h: 600 };
const image = { w: 800, h: 400 };

describe('zoomAt', () => {
	it('keeps the point under the cursor still', () => {
		const v = zoomAt(FITTED, 2, 100, 50);
		// The image point under (100, 50) was at 100/1 from the centre; now 2x.
		expect(v).toEqual({ scale: 2, x: -100, y: -50 });
		expect((100 - v.x) / v.scale).toBe(100);
	});

	it('stays within the scale limits', () => {
		expect(zoomAt(FITTED, 0.5, 0, 0).scale).toBe(1);
		expect(zoomAt({ scale: 6, x: 0, y: 0 }, 4, 0, 0).scale).toBe(MAX_SCALE);
	});
});

describe('clampView', () => {
	it('centres a fitted image', () => {
		expect(clampView({ scale: 1, x: 40, y: -30 }, stage, image)).toEqual(FITTED);
	});

	it('lets a zoomed image pan only as far as its overflow', () => {
		// At 2x the image is 1600x800: 400px spare each side horizontally, 100 vertically.
		expect(clampView({ scale: 2, x: 900, y: -500 }, stage, image)).toEqual({ scale: 2, x: 400, y: -100 });
	});
});

describe('wheelFactor', () => {
	it('zooms in on a scroll up and out on a scroll down, by about 10% a notch', () => {
		expect(wheelFactor(-50, 0)).toBeGreaterThan(1);
		expect(wheelFactor(50, 0)).toBeLessThan(1);
		expect(wheelFactor(-50, 0)).toBeCloseTo(1.105, 2);
	});

	it('reads line and page deltas as pixels and caps a burst', () => {
		expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-48, 0));
		expect(wheelFactor(-1, 2)).toBe(wheelFactor(-100, 0));
	});
});

describe('toggleZoom', () => {
	it('zooms in at the point, and back to fit when zoomed', () => {
		const v = toggleZoom(FITTED, 10, 20);
		expect(v.scale).toBe(STEP_SCALE);
		expect(toggleZoom(v, 0, 0)).toEqual(FITTED);
	});
});
