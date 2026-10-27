import { describe, expect, it } from 'vitest';
import {
	HISTORY,
	cpuPercent,
	cpuTimes,
	formatRate,
	level,
	memFromMeminfo,
	netRate,
	parseNetDev,
	percent,
	pushHistory,
	scaleRates,
	sparkArea,
	sparkPoints
} from './system-stats-core';

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

describe('network', () => {
	const dev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0
  eth0: 1000000 10 0 0 0 0 0 0 250000 7 0 0 0 0 0 0
`;

	it('reads received and sent bytes per interface', () => {
		const m = parseNetDev(dev);
		expect(m.get('eth0')).toEqual({ rx: 1000000, tx: 250000 });
		expect(m.get('lo')).toEqual({ rx: 500, tx: 500 });
	});

	it('turns two readings into bytes a second, ignoring a counter reset', () => {
		expect(netRate({ rx: 0, tx: 0 }, { rx: 3000, tx: 600 }, 3)).toEqual({ down: 1000, up: 200 });
		expect(netRate({ rx: 5000, tx: 5000 }, { rx: 10, tx: 10 }, 3)).toEqual({ down: 0, up: 0 });
	});

	it('prints a speed in a few characters', () => {
		expect([formatRate(0), formatRate(820), formatRate(340_000), formatRate(1_234_000), formatRate(45_000_000)]).toEqual([
			'0',
			'820B',
			'340K',
			'1.2M',
			'45M'
		]);
	});

	it('scales speeds against the peak, with a floor for an idle link', () => {
		expect(scaleRates([0, 500_000, 1_000_000], 1_000_000)).toEqual([0, 50, 100]);
		expect(scaleRates([1000], 1000)).toEqual([1]);
	});
});
