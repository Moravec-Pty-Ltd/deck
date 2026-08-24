// A per-turn agent CLI can hang without exiting: an unreachable model endpoint
// leaves `opencode run` blocked on a socket, producing nothing on either pipe.
// The runner only decides a turn crashed in the child's exit handler, so a child
// that never exits leaves the session `running` forever, indistinguishable from
// a long turn. Bound the silence rather than the turn.
//
// The bound has to be generous. The per-turn drivers emit on completed items,
// not on streaming deltas, so a single slow tool call (a long build, a full test
// suite) is genuinely silent on both pipes for its whole duration. Half an hour
// is past any plausible one of those while still catching a wedged CLI the same
// day; `DECK_TURN_SILENCE_MS` tunes it either way.
const DEFAULT_SILENCE_MS = 30 * 60 * 1000;

export function silenceLimitMs(env: Record<string, string | undefined>): number {
	const raw = Number(env.DECK_TURN_SILENCE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SILENCE_MS;
}

// Whole minutes read wrong for a tuned-down limit, which is exactly when someone
// is reading this message closely: 45s must not print as "0m", nor 90s as "2m".
export function describeLimit(ms: number): string {
	return ms < 120000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
}

// Calls `onSilent` once, after `limitMs` with no `bump()`. Both `bump` and a
// second trip are inert afterwards, so a stalled turn is reported exactly once.
export function startSilenceWatchdog(limitMs: number, onSilent: () => void) {
	let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
		timer = undefined;
		onSilent();
	}, limitMs);
	return {
		// Call on every chunk the child writes; restarts the countdown.
		bump() {
			timer?.refresh();
		},
		// Stop watching, once the turn has ended by any other route.
		stop() {
			clearTimeout(timer);
			timer = undefined;
		}
	};
}
