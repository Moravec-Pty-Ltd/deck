// deck is a single-instance tool: the store, the automation ledger and the
// monitor all assume one process owns the data directory. Two servers sharing
// ~/.deck silently double-fire automation and can resume each other's claude
// sessions (issue #213), so boot takes a lock. This module holds the pure part:
// what a lock record looks like, and whether an existing one is stale.

export interface InstanceLock {
	pid: number;
	port: number;
	// When the holding process itself started, not when it took the lock. The OS
	// reuses pids, so "a process with this pid exists" isn't enough to call the
	// holder alive; the live process has to be the same one that took the lock,
	// and a start time is the cheap portable way to tell.
	startedAt: number;
	heartbeat: number;
}

// The monitor's existing 10s health tick refreshes the heartbeat, so a few
// missed ticks is the threshold for "that process is gone or wedged".
export const STALE_AFTER_MS = 45_000;

// `ps` reports a start time truncated to the second and our own is derived from
// process.uptime(), so only a gap well past that counts as a different process.
const START_TIME_SLACK_MS = 2_000;

export interface HolderProbe {
	running: boolean;
	// When the live process with that pid started, or null when it couldn't be read.
	startedAt: number | null;
}

export function parseLock(value: unknown): InstanceLock | null {
	if (!value || typeof value !== 'object') return null;
	const { pid, port, startedAt, heartbeat } = value as Record<string, unknown>;
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof startedAt !== 'number' || typeof heartbeat !== 'number') return null;
	return { pid, port: typeof port === 'number' ? port : 0, startedAt, heartbeat };
}

export function lockIsStale(lock: InstanceLock | null, now: number, probe: HolderProbe): boolean {
	if (!lock) return true;
	if (!probe.running) return true;
	// Only judge a pid reused when the live start time could actually be read: an
	// unreadable one means "unknown", and taking the lock on unknown would put a
	// second server behind a healthy holder, which is the bug being fixed.
	if (probe.startedAt !== null && Math.abs(probe.startedAt - lock.startedAt) > START_TIME_SLACK_MS) return true;
	return now - lock.heartbeat > STALE_AFTER_MS;
}

export function conflictMessage(lock: InstanceLock, dir: string): string {
	return `[deck] another deck server (pid ${lock.pid}, port ${lock.port}) already owns ${dir}. Stop it, or set DECK_DATA to a different directory to run this instance against its own data.`;
}
