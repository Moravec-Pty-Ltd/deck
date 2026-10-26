// The machine's CPU, memory and disk use for the header meter. Node-free: the
// server reads the raw numbers (server/system-stats.ts) and these turn them
// into percentages; the client keeps a short history for the sparklines.

export interface SystemStats {
	cpu: number;
	mem: { used: number; total: number };
	disk: { used: number; total: number };
}

// The last HISTORY readings of each, as percentages, oldest first.
export interface SystemHistory {
	cpu: number[];
	mem: number[];
	disk: number[];
}

// Busy and total CPU time summed over every core, from os.cpus().
export interface CpuTimes {
	busy: number;
	total: number;
}

export function cpuTimes(cpus: { times: Record<string, number> }[]): CpuTimes {
	let busy = 0;
	let total = 0;
	for (const { times } of cpus) {
		const sum = Object.values(times).reduce((a, b) => a + b, 0);
		total += sum;
		busy += sum - (times.idle ?? 0);
	}
	return { busy, total };
}

// CPU use between two readings, 0 to 100.
export function cpuPercent(prev: CpuTimes, next: CpuTimes): number {
	const total = next.total - prev.total;
	if (total <= 0) return 0;
	return Math.min(100, Math.max(0, ((next.busy - prev.busy) / total) * 100));
}

// Memory in use from /proc/meminfo: total less MemAvailable, which counts
// reclaimable cache as free (MemFree alone would show a busy box as full).
export function memFromMeminfo(text: string): { used: number; total: number } | null {
	const kb = (key: string) => {
		const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
		return m ? Number(m[1]) * 1024 : null;
	};
	const total = kb('MemTotal');
	const available = kb('MemAvailable');
	return total && available !== null ? { used: total - available, total } : null;
}

export const percent = (part: { used: number; total: number }) => (part.total > 0 ? (part.used / part.total) * 100 : 0);

// How many readings a sparkline keeps: at one every 3 s, the last three minutes.
export const HISTORY = 60;

export function pushHistory(history: number[], value: number): number[] {
	const next = [...history, value];
	return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
}

// SVG polyline points for a sparkline of 0-100 values in a w x h box, newest
// at the right edge; fewer points than HISTORY start partway along.
export function sparkPoints(values: number[], w: number, h: number): string {
	const step = w / (HISTORY - 1);
	const start = w - (values.length - 1) * step;
	return values
		.map((v, i) => `${(start + i * step).toFixed(1)},${(h - (Math.min(100, Math.max(0, v)) / 100) * h).toFixed(1)}`)
		.join(' ');
}

// The same line closed down to the baseline, for a filled sparkline.
export function sparkArea(values: number[], w: number, h: number): string {
	if (!values.length) return '';
	const line = sparkPoints(values, w, h);
	return `${line.split(' ')[0].split(',')[0]},${h} ${line} ${w},${h}`;
}

// Under 70% reads as normal, then a warning, then an error from 90%.
export function level(value: number): 'ok' | 'warn' | 'high' {
	return value >= 90 ? 'high' : value >= 70 ? 'warn' : 'ok';
}

export function formatBytesShort(n: number): string {
	const gb = n / 1024 ** 3;
	return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}
