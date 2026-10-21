import { json } from '@sveltejs/kit';
import { objectBody } from './http';
import { sseResponse } from './sse';
import {
	operatorChat,
	operatorConfig,
	operatorConfigured,
	operatorHistory,
	operatorListening,
	resetOperator,
	subscribeAnnouncements
} from './operator';
import { historyLimit } from '$lib/operator-core';
import { providerFor } from '$lib/operator-providers';

// Voice-operator handlers, each shared verbatim by a browser route under
// /api/operator and its agent API twin under /api/agent/operator.

// Whether a model is configured, which one, and whether a client is listening.
export function operatorInfoRoute(): Response {
	const c = operatorConfig();
	return json({
		configured: operatorConfigured(),
		model: c.model ?? null,
		provider: providerFor(c),
		listening: operatorListening()
	});
}

// One utterance (spoken and transcribed by the client, or typed): what the
// operator said and did.
export async function operatorChatRoute({ request }: { request: Request }): Promise<Response> {
	const body = await objectBody(request);
	const source = typeof body.source === 'string' ? body.source : 'voice';
	return json(await operatorChat(String(body.text ?? ''), source));
}

// SSE: what the operator says on its own (questions, finished turns, errors)
// while this client listens. Holding the stream open is what turns the
// proactive side on; the last client leaving turns it off.
export function operatorEventsRoute(): Response {
	return sseResponse((send) => {
		send('ready', { at: Date.now() });
		return subscribeAnnouncements((a) => send('announcement', a));
	});
}

// The recent conversation, for a client's log.
export function operatorHistoryRoute({ url }: { url: URL }): Response {
	return json({ turns: operatorHistory(historyLimit(url.searchParams.get('limit'))) });
}

// Start a new conversation; the old one is archived, not deleted.
export function operatorResetRoute(): Response {
	return json({ ok: true, archived: resetOperator() });
}
