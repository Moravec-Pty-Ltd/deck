import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cachedServerStates } from '$lib/server/devservers';

// Per-session dev-server states from the monitor's last poll (no fresh probing),
// for the sidebar dots and header chip. Keyed by session id.
export const GET: RequestHandler = async () => {
	return json(cachedServerStates());
};
