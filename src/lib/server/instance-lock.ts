import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataDir } from './config';
import { conflictMessage, lockIsStale, parseLock, type HolderProbe, type InstanceLock } from './instance-lock-core';

const lockFile = path.join(dataDir, 'instance.lock');

// This process's own start time, in the same terms as `ps -o lstart=` reports
// another process's, so the two are directly comparable.
const startedAt = Date.now() - Math.round(process.uptime() * 1000);

// Written straight through fs rather than writeJson: the lock is the one thing a
// losing second instance may touch, and it should leave no tmp file behind.
function write() {
	const record: InstanceLock = {
		pid: process.pid,
		port: Number(process.env.PORT?.trim()) || 4818,
		startedAt,
		heartbeat: Date.now()
	};
	fs.writeFileSync(lockFile, JSON.stringify(record, null, '\t'));
}

function readLock(): InstanceLock | null {
	try {
		return parseLock(JSON.parse(fs.readFileSync(lockFile, 'utf8')));
	} catch {
		return null;
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means the pid exists but belongs to another user, so it's running.
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function startTimeOf(pid: number): number | null {
	try {
		const parsed = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim());
		return Number.isNaN(parsed) ? null : parsed;
	} catch {
		return null;
	}
}

function probe(pid: number): HolderProbe {
	return isRunning(pid) ? { running: true, startedAt: startTimeOf(pid) } : { running: false, startedAt: null };
}

let held = false;

// Only ever remove our own lock: if we were judged stale and taken over, the
// file on disk is the new holder's.
function removeOwnLock(): void {
	try {
		if (readLock()?.pid === process.pid) fs.unlinkSync(lockFile);
	} catch {
		// Nothing useful to do while exiting.
	}
}

function release(): void {
	if (!held) return;
	held = false;
	removeOwnLock();
}

function releaseOnShutdown(): void {
	process.on('exit', release);
	for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.on(sig, () => {
			release();
			process.exit(0);
		});
	}
}

function heldByAnother(lock: InstanceLock): boolean {
	return lock.pid !== process.pid && !lockIsStale(lock, Date.now(), probe(lock.pid));
}

// Take ownership of the data directory, or refuse to run. Called before the
// monitor's start() (ES imports are hoisted, so a statement in hooks.server.ts
// would already be too late), and exits the process outright when another live
// server holds the lock.
export function holdDataDir(): void {
	if (held) return;
	const existing = readLock();
	if (existing && heldByAnother(existing)) {
		console.error(conflictMessage(existing, dataDir));
		process.exit(1);
	}
	write();
	held = true;
	releaseOnShutdown();
}

export function refreshDataDirLock(): void {
	if (!held) return;
	try {
		write();
	} catch {
		// A transient write failure just ages the heartbeat; the next tick retries.
	}
}
