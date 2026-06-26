import { listSessions } from './sessions';
import { pollServers } from './devservers';
import { syncCapturedPrs } from './pr';
import { notify } from './push';

// Claude lifecycle (turn end, crash, question) is notified inline from the event
// stream in claude.ts. Shells have no event stream, so a lightweight poll watches
// for managed shells transitioning to dead and pushes a notification once. The
// same poll refreshes dev-server health (issue #32) and notifies on its
// errored / dead / ready transitions.

// Captured PRs sync on their own slower tick (issue #44): one bulk gh GraphQL
// call covers every non-terminal PR across all repos, so it doesn't belong on the
// 10s health poll. 75s keeps the chip/tally fresh without hammering gh.
const PR_SYNC_INTERVAL_MS = 75_000;

const g = globalThis as { __deckMonitor?: boolean; __deckPrevStatus?: Map<string, string> };

function start() {
	if (g.__deckMonitor) return;
	g.__deckMonitor = true;
	const prev = (g.__deckPrevStatus ??= new Map());
	// Re-entrancy guard: a tick now awaits pollServers (per-server tmux calls plus
	// 700ms port probes), so it can exceed the 10s interval. Without this, the next
	// tick would run concurrently, double-fire transition notifications, and race
	// the `prev` map.
	let polling = false;

	const timer = setInterval(async () => {
		if (polling) return;
		polling = true;
		try {
			let sessions;
			try {
				sessions = await listSessions();
			} catch {
				return;
			}
			const seen = new Set<string>();
			for (const s of sessions) {
				seen.add(s.id);
				const before = prev.get(s.id);
				prev.set(s.id, s.status);
				if (s.kind !== 'shell') continue;
				if (before && before !== 'dead' && s.status === 'dead') {
					notify({ title: `Shell exited · ${s.title}`, body: s.cwd, tag: s.id, url: `/s/${s.id}` });
				}
			}
			for (const id of prev.keys()) if (!seen.has(id)) prev.delete(id);
			await pollServers(sessions).catch(() => {});
		} finally {
			polling = false;
		}
	}, 10000);
	timer.unref();

	// syncCapturedPrs is single-flight internally, so a slow gh call just skips the
	// overlapping tick rather than queueing. Best-effort: swallow a stray rejection
	// (e.g. a failed store write) so the timer keeps ticking.
	const prTimer = setInterval(() => void syncCapturedPrs().catch(() => {}), PR_SYNC_INTERVAL_MS);
	prTimer.unref();
}

start();
