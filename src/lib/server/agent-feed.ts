import { EventEmitter } from 'node:events';

// Global lifecycle feed for the agent API (issue #127): one bus carrying every
// session's transitions, so /api/agent/events can multiplex all sessions on a
// single SSE stream instead of subscribers opening one per-session stream.
// Producers are the existing chokepoints (claude.ts setStatus/appendEvent,
// ask.ts, workflows.ts, sessions.ts, pr.ts, monitor.ts); this module stays
// dependency-free so any of them can import it without a cycle.

export interface AgentFeedEvent {
	sessionId: string;
	type:
		| 'status'
		| 'awaiting-input'
		| 'turn-finished'
		| 'workflow'
		| 'pr'
		| 'session-created'
		| 'session-deleted';
	at: number;
	[key: string]: unknown;
}

// Survives HMR in dev so SSE subscribers and producers share one emitter.
const g = globalThis as { __deckAgentFeed?: EventEmitter };
export const agentFeed = (g.__deckAgentFeed ??= new EventEmitter());
agentFeed.setMaxListeners(100);

export function publishAgentEvent(
	sessionId: string,
	type: AgentFeedEvent['type'],
	payload?: Record<string, unknown>
): void {
	// A throwing subscriber must not escape into the producer's frame (several
	// producers publish from .finally continuations); log and carry on.
	try {
		agentFeed.emit('event', { sessionId, type, at: Date.now(), ...payload });
	} catch (err) {
		console.error(`[deck] agent feed emit failed (${type}):`, err);
	}
}
