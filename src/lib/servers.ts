import type { ServerState } from '$lib/types';

// Client-side presentation for dev-server states (issue #32): labels, daisyUI
// badge classes, and sidebar dot classes. Kept here (no server imports) so both
// the chip component and the session page can share one mapping.

export const SERVER_LABEL: Record<ServerState, string> = {
	stopped: 'stopped',
	setup: 'setup',
	starting: 'starting',
	running: 'running',
	stalled: 'stalled',
	errored: 'errored',
	dead: 'dead'
};

export const SERVER_BADGE: Record<ServerState, string> = {
	stopped: 'badge-ghost',
	setup: 'badge-info',
	starting: 'badge-info',
	running: 'badge-success',
	stalled: 'badge-warning',
	errored: 'badge-error',
	dead: 'badge-ghost'
};

// Sidebar dot: a hollow ring for dead so it survives e-ink without colour,
// mirroring the session status dot.
export const SERVER_DOT: Record<ServerState, string> = {
	stopped: 'bg-base-content/30',
	setup: 'bg-info',
	starting: 'bg-info',
	running: 'bg-success',
	stalled: 'bg-warning',
	errored: 'bg-error',
	dead: 'border border-base-content/40'
};

// Most-attention-worthy state wins when one session runs several servers, so the
// aggregate dot/chip surfaces a problem rather than hiding it behind "running".
const PRIORITY: ServerState[] = ['errored', 'dead', 'stalled', 'starting', 'setup', 'running', 'stopped'];

export function aggregateState(states: ServerState[]): ServerState | null {
	for (const s of PRIORITY) if (states.includes(s)) return s;
	return null;
}
