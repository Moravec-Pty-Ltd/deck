// SSE plumbing shared by the per-session transcript stream and the global
// agent feed: framing, the enqueue-failure cleanup path, the 25s named `ping`
// heartbeat (a bare comment wouldn't let clients detect a silently-dead
// socket), and the response headers. `setup` sends the initial frames,
// subscribes to whatever it streams, and returns the unsubscribe.
export function sseResponse(
	setup: (send: (type: string, data: unknown) => void) => (() => void) | void
): Response {
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
			// Interval after setup, so a synchronous setup throw can't leak it.
			const teardown = setup(send);
			const ping = setInterval(() => send('ping', 1), 25000);
			cleanup = () => {
				clearInterval(ping);
				teardown?.();
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
}
