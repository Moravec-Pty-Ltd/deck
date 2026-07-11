import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentKind } from '$lib/types';
import { getSession } from '$lib/server/sessions';
import { bus, snapshotFrames } from '$lib/server/claude';
import { agentTurnRunning } from '$lib/server/agents/dispatch';
import { DEMO, demoTranscript } from '$lib/server/demo';
import { sessionCostSummary } from '$lib/session-cost-core';
import { sseResponse } from '$lib/server/sse';

// SSE: send the recent stored history, then stream live events for the session.
export const GET: RequestHandler = async ({ params }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	if (!isAgentKind(session.kind)) error(400, 'not an agent session');

	const id = session.id;

	// Demo mode: serve the canned transcript as a single snapshot frame, then hold
	// the stream open with pings (no live bus). No real session data is touched.
	if (DEMO) {
		return sseResponse((send) => {
			const events = demoTranscript(id);
			send('snapshot', {
				seq: 0,
				n: 1,
				data: JSON.stringify({ start: 0, cost: sessionCostSummary(events), events })
			});
			send('status', session.status);
		});
	}

	return sseResponse((send) => {
		// Recent history first (chunked into small frames so it actually flushes
		// — see snapshotFrames), then live events. Older history loads lazily via
		// /transcript on back-scroll.
		for (const frame of snapshotFrames(id)) send('snapshot', frame);
		send('status', agentTurnRunning(id) ? 'running' : session.status);

		const onEvent = (event: unknown) => send('transcript', event);
		const onStatus = (status: unknown) => send('status', status);
		bus.on(`event:${id}`, onEvent);
		bus.on(`status:${id}`, onStatus);

		return () => {
			bus.off(`event:${id}`, onEvent);
			bus.off(`status:${id}`, onStatus);
		};
	});
};
