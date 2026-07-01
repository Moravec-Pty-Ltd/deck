// Thin client + pure state predicates for dev-server control, shared by the
// header Run button, the command palette, and (potentially) the Servers tab so
// all three drive the same /api/sessions/[id]/servers[/name] endpoints one way.
// The predicates are node-free and unit-tested; the fetch helpers are the only
// impure part.
import type { ServerRuntime, ServerState } from './types';

export type ServerAction = 'start' | 'stop' | 'restart' | 'resetup';

// Settled off states: only from here is a plain Start offered (mirrors DevServers).
const STOPPED_STATES: ServerState[] = ['stopped', 'dead', 'errored'];

export function canStart(state: ServerState): boolean {
	return STOPPED_STATES.includes(state);
}

export function canStop(state: ServerState): boolean {
	return !STOPPED_STATES.includes(state);
}

// A re-run (full or single step) is refused server-side while a bring-up is in
// flight; callers mirror that by disabling restart/re-setup during setup/starting.
export function isInFlight(state: ServerState): boolean {
	return state === 'setup' || state === 'starting';
}

export function serverActionPath(id: string, name: string): string {
	return `/api/sessions/${encodeURIComponent(id)}/servers/${encodeURIComponent(name)}`;
}

// The configured servers + live status for a session's worktree.
export async function fetchServers(id: string): Promise<ServerRuntime[]> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/servers`);
	if (!res.ok) throw new Error(`request failed (${res.status})`);
	const data = await res.json();
	return data.servers ?? [];
}

// POST a lifecycle action; throws with the endpoint's message on failure so the
// caller can surface it inline, exactly as DevServers/PrMenu do.
export async function serverAction(id: string, name: string, action: ServerAction): Promise<void> {
	const res = await fetch(serverActionPath(id, name), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action })
	});
	if (!res.ok) {
		const data = await res.json().catch(() => null);
		throw new Error(data?.message || 'action failed');
	}
}
