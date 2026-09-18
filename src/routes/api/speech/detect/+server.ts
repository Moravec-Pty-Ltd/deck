import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { detectLocalSpeechServer } from '$lib/server/speech';

// Probe the local chatterbox server so the Settings page can fill the speech
// fields in one click. { found: false } when nothing answers.
export const POST: RequestHandler = async () => {
	const found = await detectLocalSpeechServer();
	return json(found ? { found: true, ...found } : { found: false });
};
