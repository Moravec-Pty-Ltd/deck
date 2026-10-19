import type { SessionView } from '$lib/session-view';
import {
	applyResponse,
	backoffMs,
	cursorWentBack,
	feedUrl,
	type FeedResponse,
	type FeedState
} from '$lib/session-feed-core';

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
	});
}

// The live session list for a page: bootstraps from the agent event log, then
// long-polls it, so a change lands as it happens rather than on a 5s timer.
// One request is in flight at a time. A hidden tab holds no request open; it
// re-snapshots on return, which also picks up the changes the log does not
// carry (a model or effort switch). Call resync() after a change of your own for
// the same reason.
class SessionFeed {
	sessions = $state.raw<SessionView[]>([]);
	loaded = $state(false);

	#state: FeedState | null = null;
	#ctrl: AbortController | null = null;
	#running = false;
	#failures = 0;

	start = (): (() => void) => {
		this.#running = true;
		document.addEventListener('visibilitychange', this.#onVisibility);
		void this.#loop();
		return this.#stop;
	};

	resync = () => {
		this.#state = null;
		this.#ctrl?.abort();
	};

	#stop = () => {
		this.#running = false;
		document.removeEventListener('visibilitychange', this.#onVisibility);
		this.#ctrl?.abort();
	};

	#onVisibility = () => {
		// Hidden: drop the held request. Visible: wake the loop onto a fresh snapshot.
		this.resync();
	};

	async #loop() {
		while (this.#running) {
			const ctrl = (this.#ctrl = new AbortController());
			if (document.hidden) await delay(2 ** 31 - 1, ctrl.signal);
			else await this.#step(ctrl.signal);
		}
	}

	async #step(signal: AbortSignal) {
		try {
			const body = await this.#read(signal);
			// A resync landed while this was in flight: its cursor is stale.
			if (signal.aborted) return;
			this.#take(body);
			this.#failures = 0;
		} catch {
			await this.#backoff(signal);
		}
	}

	async #read(signal: AbortSignal): Promise<FeedResponse> {
		const res = await fetch(feedUrl(this.#state), { signal });
		if (!res.ok) throw new Error(`feed ${res.status}`);
		return res.json();
	}

	async #backoff(signal: AbortSignal) {
		if (signal.aborted) return;
		this.#failures++;
		await delay(backoffMs(this.#failures), signal);
	}

	#take(res: FeedResponse) {
		if (cursorWentBack(this.#state, res)) {
			this.#state = null;
			return;
		}
		const next = applyResponse(this.#state, res);
		if (next !== this.#state) this.sessions = next.sessions;
		this.#state = next;
		this.loaded = true;
	}
}

// A page's session list plus a poll for whatever else it shows. refresh() does
// both at once, for after a change of the page's own: some (a model or effort
// switch) never reach the event log. Call during component init.
export function liveSessions(poll: () => Promise<void>, ms = 5000) {
	const feed = new SessionFeed();
	$effect(() => feed.start());
	$effect(() => {
		void poll();
		const interval = setInterval(poll, ms);
		return () => clearInterval(interval);
	});
	return {
		feed,
		refresh: () => {
			feed.resync();
			return poll();
		}
	};
}
