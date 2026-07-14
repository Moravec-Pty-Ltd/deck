import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requestPairing } from '$lib/server/pairing';

// Public (see PUBLIC_PATHS in hooks.server.ts): a new, unauthenticated device asks
// for access. Returns its polling secret + a short display code; an authenticated
// browser must then approve it before the secret unlocks anything.
//
// This is a public, state-changing endpoint (it creates a request and nudges
// devices via push), and SvelteKit's CSRF guard only covers form content-types, so
// a cross-site no-cors POST could otherwise drive-by spam it. Require a same-origin
// Origin when one is present (browsers always send it on cross-origin POSTs).
export const POST: RequestHandler = async ({ request, url }) => {
	const origin = request.headers.get('origin');
	if (origin && origin !== url.origin) error(403, 'cross-origin request rejected');
	return json(requestPairing());
};
