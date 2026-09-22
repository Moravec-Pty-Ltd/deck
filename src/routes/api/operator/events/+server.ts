import type { RequestHandler } from './$types';
import { sseResponse } from '$lib/server/sse';
import { subscribeAnnouncements } from '$lib/server/operator';

// SSE: what the operator says on its own (questions, finished turns, errors)
// while this client listens. Holding the stream open is what turns the
// proactive side on; the last client leaving turns it off.
export const GET: RequestHandler = () => {
	return sseResponse((send) => {
		send('ready', { at: Date.now() });
		return subscribeAnnouncements((a) => send('announcement', a));
	});
};
