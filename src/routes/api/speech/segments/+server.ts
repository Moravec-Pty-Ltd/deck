import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { objectBody } from '$lib/server/http';
import { prepareSegments, pruneSpeechCache, speechConfig } from '$lib/server/speech';

// Split reply text into the sentence segments voice mode plays, each with the
// id its audio is fetched by (GET /api/speech/audio/{id}). Synthesis happens
// on that fetch, so a client can start the first segment while later ones
// are still being made.
export const POST: RequestHandler = async ({ request }) => {
	if (!speechConfig().ttsUrl) error(400, 'no text-to-speech server configured');
	const body = await objectBody(request);
	if (typeof body.text !== 'string') error(400, 'text must be a string');
	pruneSpeechCache();
	return json({ segments: prepareSegments(body.text) });
};
