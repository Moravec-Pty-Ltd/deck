import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requestPairing } from '$lib/server/pairing';

// Public (see PUBLIC_PATHS in hooks.server.ts): a new, unauthenticated device asks
// for access. Returns its polling secret + a short display code; an authenticated
// browser must then approve it before the secret unlocks anything.
export const POST: RequestHandler = async () => {
	return json(requestPairing());
};
