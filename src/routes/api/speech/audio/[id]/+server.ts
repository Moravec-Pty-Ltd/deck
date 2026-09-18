import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { segmentAudio } from '$lib/server/speech';

// One segment's audio, synthesised on first request and cached. The id is a
// content hash, so the bytes behind it never change: cache hard.
export const GET: RequestHandler = async ({ params }) => {
	let wav: Buffer | null;
	try {
		wav = await segmentAudio(params.id);
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
};
