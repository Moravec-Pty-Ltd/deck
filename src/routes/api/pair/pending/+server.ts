import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listPending } from '$lib/server/pairing';

// Authed (not in PUBLIC_PATHS): the live access requests the current browser may
// approve. The home page reads this on its poll to surface an approval prompt.
export const GET: RequestHandler = async () => {
	return json({ pending: listPending() });
};
