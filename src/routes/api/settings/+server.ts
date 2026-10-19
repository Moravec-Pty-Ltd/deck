import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readSettings } from '$lib/server/store';

// The unredacted settings file, kept for the new-session modal until it moves
// to GET /api/agent/settings. Writes go through PATCH /api/agent/settings.
export const GET: RequestHandler = async () => {
	return json(readSettings());
};
