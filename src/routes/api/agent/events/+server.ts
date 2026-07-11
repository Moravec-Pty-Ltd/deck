import type { RequestHandler } from './$types';
import { listSessions } from '$lib/server/sessions';
import { sessionDigest } from '$lib/server/agent-digest';
import { agentFeed } from '$lib/server/agent-feed';
import { sseResponse } from '$lib/server/sse';

// SSE: the global monitor feed (issue #127). One stream multiplexes every
// session's lifecycle events, so an orchestrator subscribes once instead of
// polling N sessions or opening N per-session streams. Mirrors the per-session
// /events pattern: an initial `snapshot` frame (the digest of all sessions),
// then live `delta` frames { sessionId, type, at, ...payload }, plus a named
// `ping` heartbeat. Delta types: status, awaiting-input, turn-finished,
// workflow, pr, session-created, session-deleted.
export const GET: RequestHandler = async () => {
	// Subscribe before the snapshot read: an event landing while listSessions()
	// awaits would otherwise be in neither the snapshot nor the deltas. Buffered
	// events are flushed after the snapshot frame; one may duplicate state the
	// snapshot already reflects, which a monitor applies idempotently.
	const buffered: unknown[] = [];
	const buffer = (event: unknown) => buffered.push(event);
	agentFeed.on('event', buffer);

	let sessions;
	try {
		sessions = (await listSessions()).map(sessionDigest);
	} catch (e) {
		agentFeed.off('event', buffer);
		throw e;
	}

	// sseResponse runs setup synchronously on construction, so the swap from
	// the buffer listener to the live one leaves no gap.
	return sseResponse((send) => {
		send('snapshot', sessions);
		const onEvent = (event: unknown) => send('delta', event);
		agentFeed.off('event', buffer);
		for (const event of buffered) onEvent(event);
		agentFeed.on('event', onEvent);
		return () => agentFeed.off('event', onEvent);
	});
};
