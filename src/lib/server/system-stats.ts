import fs from 'node:fs';
import os from 'node:os';
import {
	cpuPercent,
	cpuTimes,
	memFromMeminfo,
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
let history: SystemHistory = { cpu: [], mem: [], disk: [] };
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

function sample(): SystemStats {
	const times = cpuTimes(os.cpus());
	const stats = { cpu: cpuPercent(prevTimes ?? { busy: 0, total: 0 }, times), mem: memory(), disk: disk() };
	prevTimes = times;
	latest = stats;
	history = {
		cpu: pushHistory(history.cpu, stats.cpu),
		mem: pushHistory(history.mem, percent(stats.mem)),
		disk: pushHistory(history.disk, percent(stats.disk))
	};
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
