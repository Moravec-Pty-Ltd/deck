// The machine's CPU, memory, disk and network use for the header meter. Node-free: the
// server reads the raw numbers (server/system-stats.ts) and these turn them
// into percentages; the client keeps a short history for the sparklines.

export interface SystemStats {
	cpu: number;
	mem: { used: number; total: number };
	disk: { used: number; total: number };
	// Bytes a second over the physical interfaces; null where unreadable.
	net: { down: number; up: number } | null;
}

// The last HISTORY readings of each, oldest first: percentages, except the
// network's, which are bytes a second.
export interface SystemHistory {
	cpu: number[];
	mem: number[];
	disk: number[];
	down: number[];
	up: number[];
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

// Received and sent byte counters per interface, from /proc/net/dev.
export function parseNetDev(text: string): Map<string, { rx: number; tx: number }> {
	const out = new Map<string, { rx: number; tx: number }>();
	for (const line of text.split('\n').slice(2)) {
		const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
		if (!m) continue;
		const f = m[2].trim().split(/\s+/).map(Number);
		if (f.length >= 9) out.set(m[1], { rx: f[0], tx: f[8] });
	}
	return out;
}

// Bytes a second between two counter readings taken `seconds` apart. A counter
// that went backwards (an interface reset) reads as no traffic.
export function netRate(prev: { rx: number; tx: number }, next: { rx: number; tx: number }, seconds: number) {
	if (seconds <= 0) return { down: 0, up: 0 };
	return { down: Math.max(0, next.rx - prev.rx) / seconds, up: Math.max(0, next.tx - prev.tx) / seconds };
}

// A speed as a few characters: 0, 820B, 340K, 1.2M (bytes a second).
export function formatRate(n: number): string {
	if (n < 1) return '0';
	if (n < 1000) return `${Math.round(n)}B`;
	const units = ['K', 'M', 'G'];
	let v = n / 1000;
	let i = 0;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

// Speeds as percentages of the busiest moment shown, so the sparkline uses its
// height; the floor keeps an idle link from drawing noise as full-height spikes.
export function scaleRates(values: number[], peak: number, floor = 100_000): number[] {
	const top = Math.max(peak, floor);
	return values.map((v) => (v / top) * 100);
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
