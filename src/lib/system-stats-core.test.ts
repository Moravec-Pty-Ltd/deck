import { describe, expect, it } from 'vitest';
import { HISTORY, cpuPercent, cpuTimes, level, memFromMeminfo, percent, pushHistory, sparkArea, sparkPoints } from './system-stats-core';

describe('cpu', () => {
	it('sums busy and total time over the cores', () => {
		const t = cpuTimes([
			{ times: { user: 30, nice: 0, sys: 10, idle: 60, irq: 0 } },
			{ times: { user: 10, nice: 0, sys: 0, idle: 90, irq: 0 } }
		]);
		expect(t).toEqual({ busy: 50, total: 200 });
	});

	it('reports the busy share between two readings, clamped to 0-100', () => {
		expect(cpuPercent({ busy: 50, total: 200 }, { busy: 80, total: 300 })).toBe(30);
		expect(cpuPercent({ busy: 50, total: 200 }, { busy: 50, total: 200 })).toBe(0);
	});
});

describe('memFromMeminfo', () => {
	it('counts MemAvailable as free', () => {
		const text = 'MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    8000000 kB\n';
		expect(memFromMeminfo(text)).toEqual({ used: 8000000 * 1024, total: 16000000 * 1024 });
		expect(percent(memFromMeminfo(text)!)).toBe(50);
	});

	it('gives up without the fields it needs', () => {
		expect(memFromMeminfo('MemTotal: 100 kB\n')).toBeNull();
	});
});

describe('history and sparkline', () => {
	it('keeps the last HISTORY readings', () => {
		let h: number[] = [];
		for (let i = 0; i < HISTORY + 5; i++) h = pushHistory(h, i);
		expect(h).toHaveLength(HISTORY);
		expect(h[0]).toBe(5);
	});

	it('draws newest at the right edge, 100% at the top', () => {
		expect(sparkPoints([0, 100], 59, 10)).toBe('58.0,10.0 59.0,0.0');
	});

	it('closes the area down to the baseline', () => {
		expect(sparkArea([0, 100], 59, 10)).toBe('58.0,10 58.0,10.0 59.0,0.0 59,10');
		expect(sparkArea([], 59, 10)).toBe('');
	});

	it('grades a reading', () => {
		expect([level(10), level(75), level(95)]).toEqual(['ok', 'warn', 'high']);
	});
});
