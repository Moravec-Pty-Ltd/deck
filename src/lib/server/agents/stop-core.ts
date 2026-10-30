// What a Stop did, so the caller can tell a stopped turn from one there was
// nothing to stop (issue #361).
export type StopOutcome = 'interrupted' | 'nothing-running' | 'not-tracked';

// `live`: a process or a starting process for the session took the stop.
// `statusRunning`: the stored status still says running. With no live turn
// behind it that status is stale, and the caller clears it.
export function stopOutcome(live: boolean, statusRunning: boolean): StopOutcome {
	if (live) return 'interrupted';
	return statusRunning ? 'not-tracked' : 'nothing-running';
}
