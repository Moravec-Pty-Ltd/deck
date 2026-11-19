import fs from 'node:fs';
import os from 'node:os';
import {
	cpuPercent,
	cpuTimes,
	memFromMeminfo,
	netRate,
	parseNetDev,
	percent,
	pushHistory,
	type CpuTimes,
	type SystemHistory,
	type SystemStats
} from '$lib/system-stats-core';

// Sampled every 3 s from the first request on, so a meter opened later still
// draws the last three minutes. CPU use is the change since the previous sample.
const SAMPLE_MS = 3000;

let prevTimes: CpuTimes | null = null;
let latest: SystemStats | null = null;
let history: SystemHistory = { cpu: [], mem: [], disk: [], down: [], up: [] };
let prevNet: { at: number; rx: number; tx: number } | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function memory(): SystemStats['mem'] {
	try {
		const parsed = memFromMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
		if (parsed) return parsed;
	} catch {
		// Not Linux; fall back to Node's figures.
	}
	return { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

// The disk holding the home directory, where deck's data and projects live.
function disk(): SystemStats['disk'] {
	try {
		const s = fs.statfsSync(os.homedir());
		return { used: (s.blocks - s.bfree) * s.bsize, total: (s.blocks - s.bfree + s.bavail) * s.bsize };
	} catch {
		return { used: 0, total: 0 };
	}
}

// Physical interfaces only: Docker's bridges and veth pairs (and loopback) live
// under /sys/devices/virtual and would count container traffic twice.
function isPhysical(name: string): boolean {
	try {
		return !fs.realpathSync(`/sys/class/net/${name}`).includes('/virtual/');
	} catch {
		return false;
	}
}

// Received and sent bytes summed over the physical interfaces.
function netCounters(): { rx: number; tx: number } | null {
	try {
		const physical = [...parseNetDev(fs.readFileSync('/proc/net/dev', 'utf8'))].filter(([name]) => isPhysical(name));
		return physical.reduce((a, [, c]) => ({ rx: a.rx + c.rx, tx: a.tx + c.tx }), { rx: 0, tx: 0 });
	} catch {
		return null;
	}
}

// Speed since the previous sample; the first sample has nothing to compare with.
function network(): SystemStats['net'] {
	const counters = netCounters();
	if (!counters) return null;
	const at = Date.now();
	const rate = prevNet ? netRate(prevNet, counters, (at - prevNet.at) / 1000) : { down: 0, up: 0 };
	prevNet = { at, ...counters };
	return rate;
}

function cpu(): number {
	const times = cpuTimes(os.cpus());
	const value = cpuPercent(prevTimes ?? { busy: 0, total: 0 }, times);
	prevTimes = times;
	return value;
}

function record(stats: SystemStats) {
	const net = stats.net ?? { down: 0, up: 0 };
	history = {
		cpu: pushHistory(history.cpu, stats.cpu),
		mem: pushHistory(history.mem, percent(stats.mem)),
		disk: pushHistory(history.disk, percent(stats.disk)),
		down: pushHistory(history.down, net.down),
		up: pushHistory(history.up, net.up)
	};
}

function sample(): SystemStats {
	const stats = { cpu: cpu(), mem: memory(), disk: disk(), net: network() };
	latest = stats;
	record(stats);
	return stats;
}

export function systemStats(): SystemStats & { history: SystemHistory } {
	if (!timer) {
		sample();
		timer = setInterval(sample, SAMPLE_MS);
		timer.unref?.();
	}
	return { ...(latest ?? sample()), history };
}
