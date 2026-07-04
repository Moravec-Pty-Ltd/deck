import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readSettings } from '$lib/server/store';

// App-wide user preferences (~/.deck/settings.json). Currently just the global
// last-model-per-kind the new-session modal uses as a fresh-project default.
export const GET: RequestHandler = async () => {
	return json(readSettings());
};
