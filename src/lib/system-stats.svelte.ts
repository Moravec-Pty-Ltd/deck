import { agentGet, agentPath } from './agent-api';
import type { SystemHistory, SystemStats } from './system-stats-core';

// One poller shared by every meter on the page: it runs while at least one
// meter is mounted and the tab is visible, every 3 s. The server keeps the
// history, so a meter draws the last three minutes as soon as it opens.
const INTERVAL_MS = 3000;

class SystemMonitor {
	latest = $state<SystemStats | null>(null);
	cpu = $state<number[]>([]);
	mem = $state<number[]>([]);
	disk = $state<number[]>([]);
	#users = 0;
	#timer: ReturnType<typeof setInterval> | undefined;

	async #poll() {
		if (document.visibilityState !== 'visible') return;
		try {
			const s = await agentGet<SystemStats & { history: SystemHistory }>(agentPath('system'));
			this.latest = s;
			this.cpu = s.history.cpu;
			this.mem = s.history.mem;
			this.disk = s.history.disk;
		} catch {
			// A missed reading leaves a gap of one; the next poll catches up.
		}
	}

	#onVisible = () => {
		if (document.visibilityState === 'visible') void this.#poll();
	};

	// Called by a meter on mount; the returned function releases it.
	use(): () => void {
		if (this.#users++ === 0) {
			void this.#poll();
			this.#timer = setInterval(() => void this.#poll(), INTERVAL_MS);
			document.addEventListener('visibilitychange', this.#onVisible);
		}
		return () => {
			if (--this.#users > 0) return;
			clearInterval(this.#timer);
			document.removeEventListener('visibilitychange', this.#onVisible);
		};
	}
}

export const systemMonitor = new SystemMonitor();
