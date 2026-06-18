import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentKind } from '$lib/types';
import { getSession } from '$lib/server/sessions';
import { bus, snapshotFrames } from '$lib/server/claude';
import { agentTurnRunning } from '$lib/server/agents/dispatch';

// SSE: send the recent stored history, then stream live events for the session.
export const GET: RequestHandler = async ({ params }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	if (!isAgentKind(session.kind)) error(400, 'not an agent session');

	const id = session.id;
	const encoder = new TextEncoder();
	let cleanup = () => {};

	const stream = new ReadableStream({
		start(controller) {
			const send = (type: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					cleanup();
				}
			};

			// Recent history first (chunked into small frames so it actually flushes
			// — see snapshotFrames), then live events. Older history loads lazily via
			// /transcript on back-scroll.
			for (const frame of snapshotFrames(id)) send('snapshot', frame);
			send('status', agentTurnRunning(id) ? 'running' : session.status);

			const onEvent = (event: unknown) => send('transcript', event);
			const onStatus = (status: unknown) => send('status', status);
			bus.on(`event:${id}`, onEvent);
			bus.on(`status:${id}`, onStatus);

			// Named event (not a bare comment) so the client can use it as a
			// liveness heartbeat and reconnect a silently-dead socket.
			const ping = setInterval(() => {
				try {
					controller.enqueue(encoder.encode('event: ping\ndata: 1\n\n'));
				} catch {
					cleanup();
				}
			}, 25000);

			cleanup = () => {
				clearInterval(ping);
				bus.off(`event:${id}`, onEvent);
				bus.off(`status:${id}`, onStatus);
			};
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
