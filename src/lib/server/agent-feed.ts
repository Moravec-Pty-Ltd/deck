import { EventEmitter } from 'node:events';
import { appendEventLog } from './event-log';

// Global lifecycle feed for the agent API (issues #127, #143): every session
// transition is assigned a monotonic `seq`, appended to the durable event log,
// and emitted on this in-process bus. The durable log (~/.deck/events.jsonl) is
// now the consumption surface — a consumer tails the file or reads the resumable
// /api/agent/events cursor — so the emitter's only remaining job is to wake that
// cursor's long-poll. Producers are the existing chokepoints (claude.ts
// setStatus/appendEvent, ask.ts, sessions.ts, pr.ts, monitor.ts).

export interface AgentFeedEvent {
	// Global monotonic cursor: the single handle a consumer resumes from, shared by
	// the log line and this in-memory event.
	seq: number;
	sessionId: string;
	type:
		| 'status'
		| 'awaiting-input'
		| 'turn-finished'
		| 'pr'
		| 'session-created'
		| 'session-deleted';
	at: number;
	[key: string]: unknown;
}

// Survives HMR in dev so long-poll waiters and producers share one emitter.
const g = globalThis as { __deckAgentFeed?: EventEmitter };
export const agentFeed = (g.__deckAgentFeed ??= new EventEmitter());
agentFeed.setMaxListeners(100);

export function publishAgentEvent(
	sessionId: string,
	type: AgentFeedEvent['type'],
	payload?: Record<string, unknown>
): void {
	// seq is a placeholder until appendEventLog commits the durable write and
	// stamps the real value (0 means the write failed and this event was dropped).
	const event: AgentFeedEvent = { seq: 0, sessionId, type, at: Date.now(), ...payload };
	// Append durably first, then wake the feed once the line is on disk, so a
	// long-poll reader that wakes always finds the event via readCursor (the same
	// event-after-write ordering appendEvent uses for the transcript). A throwing
	// subscriber must not escape into the producer's frame (several publish from
	// .finally continuations); log and carry on.
	appendEventLog(event).finally(() => {
		if (event.seq === 0) return; // write failed: nothing durable to signal
		try {
			agentFeed.emit('event', event);
		} catch (err) {
			console.error(`[deck] agent feed emit failed (${type}):`, err);
		}
	});
}
