import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { objectBody } from '$lib/server/http';
import { operatorChat, operatorConfig, operatorConfigured, operatorListening } from '$lib/server/operator';

// The voice operator. GET says whether a model is configured; POST { text }
// is one utterance (spoken and transcribed by the client, or typed) and
// returns what the operator said and did.
export const GET: RequestHandler = () => {
	return json({ configured: operatorConfigured(), model: operatorConfig().model ?? null, listening: operatorListening() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await objectBody(request);
	const source = typeof body.source === 'string' ? body.source : 'voice';
	return json(await operatorChat(String(body.text ?? ''), source));
};
