import { listSessions } from './sessions';
import { pollServers } from './devservers';
import { notify } from './push';

// Claude lifecycle (turn end, crash, question) is notified inline from the event
// stream in claude.ts. Shells have no event stream, so a lightweight poll watches
// for managed shells transitioning to dead and pushes a notification once. The
// same poll refreshes dev-server health (issue #32) and notifies on its
// errored / dead / ready transitions.

const g = globalThis as { __deckMonitor?: boolean; __deckPrevStatus?: Map<string, string> };

function start() {
	if (g.__deckMonitor) return;
	g.__deckMonitor = true;
	const prev = (g.__deckPrevStatus ??= new Map());

	const timer = setInterval(async () => {
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
	}, 10000);
	timer.unref();
}

start();
