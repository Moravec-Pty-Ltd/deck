import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { speechCapabilities, speechConfig } from '$lib/server/speech';

// What voice mode can do here: which halves (tts, stt) are configured and
// answering, and the voice replies are read in. Clients hide the feature when
// neither is available. `config` is the stored URLs, for the Settings page.
export const GET: RequestHandler = async () => {
	const capabilities = await speechCapabilities();
	return json({ ...capabilities, config: speechConfig() });
};
