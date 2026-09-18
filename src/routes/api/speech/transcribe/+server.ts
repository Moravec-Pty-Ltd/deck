import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { speechConfig, transcribeAudio } from '$lib/server/speech';

// Push-to-talk audio in (raw body, any container the speech server's ffmpeg
// reads: m4a from iOS, webm/opus or mp4 from browsers, wav), text out.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const POST: RequestHandler = async ({ request }) => {
	if (!speechConfig().sttUrl) error(400, 'no speech-to-text server configured');
	const type = request.headers.get('content-type') ?? 'application/octet-stream';
	if (!type.startsWith('audio/') && !type.startsWith('video/') && type !== 'application/octet-stream') {
		error(400, 'send the recording as the request body with its audio content-type');
	}
	const audio = Buffer.from(await request.arrayBuffer());
	if (!audio.length) error(400, 'empty audio');
	if (audio.length > MAX_AUDIO_BYTES) error(413, 'recording too large');
	try {
		return json(await transcribeAudio(audio, type));
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'transcription failed');
	}
};
