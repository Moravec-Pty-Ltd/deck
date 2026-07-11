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
	const sessions = (await listSessions()).map(sessionDigest);
	return sseResponse((send) => {
		send('snapshot', sessions);
		const onEvent = (event: unknown) => send('delta', event);
		agentFeed.on('event', onEvent);
		return () => agentFeed.off('event', onEvent);
	});
};
