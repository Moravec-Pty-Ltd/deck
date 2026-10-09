// Pure logic for tearing down an idle claude process. The process (and its
// resume state) is cheap to respawn, but background work it started (subagents,
// `run_in_background` shells) lives inside it and dies with it, so a session
// whose turn ended while that work was still going must not be torn down.

export const IDLE_MS = 20 * 60 * 1000;

// Upper bound on how long background work keeps an idle process alive. A
// backgrounded dev server never finishes, so without a cap its process would
// be held forever.
export const BACKGROUND_HOLD_MS = 4 * 60 * 60 * 1000;

// Number of running background tasks reported by a `background_tasks_changed`
// system event (the full current list, empty once everything has finished), or
// undefined for any other event.
export function backgroundTaskCount(event: Record<string, unknown>): number | undefined {
	if (event.type !== 'system' || event.subtype !== 'background_tasks_changed') return undefined;
	return Array.isArray(event.tasks) ? event.tasks.length : 0;
}

export type TeardownDecision =
	| { action: 'kill' }
	| { action: 'skip' } // a turn is running; the next turn end reschedules
	| { action: 'wait'; ms: number }; // background work is still going

// What to do when the idle timer fires. `idleSince` is when the last turn
// ended; the hold cap counts from then.
export function teardownDecision(state: {
	running: boolean;
	backgroundTasks: number;
	idleSince: number;
	now: number;
	holdMs?: number;
}): TeardownDecision {
	if (state.running) return { action: 'skip' };
	if (state.backgroundTasks <= 0) return { action: 'kill' };
	const left = state.idleSince + (state.holdMs ?? BACKGROUND_HOLD_MS) - state.now;
	return left > 0 ? { action: 'wait', ms: left } : { action: 'kill' };
}
