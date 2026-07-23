import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cachedReviews } from '$lib/server/morabot';

// The morabot review snapshot from the monitor's last poll (issue #188): the
// in-flight review plus recent verdicts, or `unconfigured` when DECK_MORABOT_STATUS
// is unset (the sidebar hides its Reviews section). No fresh file read here.
export const GET: RequestHandler = async () => {
	return json(cachedReviews());
};
