import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/sessions';
import { readImage } from '$lib/server/images';

// Serve a user attachment stored out-of-band (see images.ts). Filenames are
// content-addressed, so the bytes behind one never change: cache hard.
export const GET: RequestHandler = async ({ params }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	const img = readImage(params.id, params.file);
	if (!img) error(404, 'image not found');
	// Copy into a plain Uint8Array; the Node Buffer type isn't structurally a
	// BodyInit, and this overload yields the ArrayBuffer-backed array Response wants.
	return new Response(new Uint8Array(img.data), {
		headers: {
			'content-type': img.media_type,
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
};
