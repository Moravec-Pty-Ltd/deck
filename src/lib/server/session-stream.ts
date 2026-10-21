import { error, json } from '@sveltejs/kit';
import { isAgentKind, type DeckSession } from '$lib/types';
import { getSession } from './sessions';
import { bus, hasProcess, sessionAgents, snapshotFrames } from './claude';
import { emptyAgents } from '$lib/subagents-core';
import { agentTurnRunning } from './agents/dispatch';
import { DEMO, demoTranscript } from './demo';
import { refreshPrOnOpen } from './pr';
import { sessionCostSummary } from '$lib/session-cost-core';
import { sseResponse } from './sse';

// Demo mode: serve the canned transcript as a single snapshot frame, then hold
// the stream open with pings (no live bus). No real session data is touched.
function demoStream(session: DeckSession): Response {
	return sseResponse((send) => {
		const events = demoTranscript(session.id);
		send('snapshot', {
			seq: 0,
			n: 1,
			data: JSON.stringify({ start: 0, cost: sessionCostSummary(events), events })
		});
		send('status', session.status);
	});
}

// Recent history first (chunked into small frames so it actually flushes, see
// snapshotFrames), then live events. Older history loads lazily via the
// transcript / history range route on back-scroll.
function liveStream(session: DeckSession): Response {
	const id = session.id;
	return sseResponse((send) => {
		// Without a claude process no subagent can still be running, whatever the
		// transcript last said.
		for (const frame of snapshotFrames(id, session.kind !== 'claude' || hasProcess(id))) send('snapshot', frame);
		send('status', agentTurnRunning(id) ? 'running' : session.status);

		const onEvent = (event: unknown) => send('transcript', event);
		const onStatus = (status: unknown) => send('status', status);
		const onExit = () => send('exit', '1');
		bus.on(`event:${id}`, onEvent);
		bus.on(`status:${id}`, onStatus);
		bus.on(`exit:${id}`, onExit);

		return () => {
			bus.off(`event:${id}`, onEvent);
			bus.off(`status:${id}`, onStatus);
			bus.off(`exit:${id}`, onExit);
		};
	});
}

// The per-session SSE stream, shared verbatim by the browser's
// /api/sessions/[id]/events and the agent API's /api/agent/sessions/[id]/stream.
// Opening a stream is opening the session, so it kicks the same non-blocking PR
// refresh the browser's session GET does (deduped in pr.ts, so a client that
// hits both costs one gh call).
export async function sessionStreamRoute(event: {
	params: Partial<Record<string, string>>;
}): Promise<Response> {
	const session = await getSession(event.params.id!);
	if (!session) error(404, 'session not found');
	if (!isAgentKind(session.kind)) error(400, 'not an agent session');
	if (DEMO) return demoStream(session);
	refreshPrOnOpen(session.id);
	return liveStream(session);
}

// Every subagent of the session with its full report, shared by the browser's
// /api/sessions/[id]/agents and the agent API's /api/agent/sessions/[id]/agents.
// The snapshot leaves out the reports of finished agents launched before its
// history window; a client fetches them here once it scrolls back that far.
export async function sessionAgentsRoute(event: { params: Partial<Record<string, string>> }): Promise<Response> {
	const session = await getSession(event.params.id!);
	if (!session) error(404, 'session not found');
	if (DEMO) return json(emptyAgents());
	return json(sessionAgents(session.id, session.kind !== 'claude' || hasProcess(session.id)));
}
