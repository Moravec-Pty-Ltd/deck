import { error, json } from '@sveltejs/kit';
import { objectBody } from './http';
import {
	prepareSegments,
	pruneSpeechCache,
	segmentAudio,
	speechCapabilities,
	speechConfig,
	transcribeAudio
} from './speech';

// Voice-mode handlers, each shared verbatim by a browser route under
// /api/speech and its agent API twin under /api/agent/speech.

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// Which halves (tts, stt) are configured and answering, the voice replies are
// read in, and the stored URLs for a settings form.
export async function speechInfoRoute(): Promise<Response> {
	const capabilities = await speechCapabilities();
	return json({ ...capabilities, config: speechConfig() });
}

// Split reply text into the sentence segments voice mode plays. Synthesis
// happens when a segment's audio is fetched, so a client can start the first
// while later ones are still being made.
export async function speechSegmentsRoute({ request }: { request: Request }): Promise<Response> {
	if (!speechConfig().ttsUrl) error(400, 'no text-to-speech server configured');
	const body = await objectBody(request);
	if (typeof body.text !== 'string') error(400, 'text must be a string');
	pruneSpeechCache();
	return json({ segments: prepareSegments(body.text) });
}

// One segment's audio, synthesised on first request and cached. The id is a
// content hash, so the bytes behind it never change: cache hard.
export async function speechAudioRoute({ params }: { params: Partial<Record<string, string>> }): Promise<Response> {
	let wav: Buffer | null;
	try {
		wav = await segmentAudio(params.id ?? '');
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'speech synthesis failed');
	}
	if (!wav) error(404, 'unknown speech segment');
	return new Response(new Uint8Array(wav), {
		headers: {
			'content-type': 'audio/wav',
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
}

function isAudioType(type: string): boolean {
	return type.startsWith('audio/') || type.startsWith('video/') || type === 'application/octet-stream';
}

// Push-to-talk audio in (raw body, any container the speech server's ffmpeg
// reads: m4a from iOS, webm/opus or mp4 from browsers, wav), text out.
export async function speechTranscribeRoute({ request }: { request: Request }): Promise<Response> {
	if (!speechConfig().sttUrl) error(400, 'no speech-to-text server configured');
	const type = request.headers.get('content-type') ?? 'application/octet-stream';
	if (!isAudioType(type)) error(400, 'send the recording as the request body with its audio content-type');
	const audio = Buffer.from(await request.arrayBuffer());
	if (!audio.length) error(400, 'empty audio');
	if (audio.length > MAX_AUDIO_BYTES) error(413, 'recording too large');
	try {
		return json(await transcribeAudio(audio, type));
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'transcription failed');
	}
}
