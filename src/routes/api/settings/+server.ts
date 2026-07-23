import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { DeckSettings } from '$lib/types';
import { readSettings, saveSettings } from '$lib/server/store';

// App-wide user preferences (~/.deck/settings.json). Currently the global
// last-model/effort the new-session modal uses as a fresh-project default, plus
// the "Open in Zed" SSH target override.
export const GET: RequestHandler = async () => {
	return json(readSettings());
};

// Whole-object write: the client sends the full settings back, matching how the
// store helpers keep it.
export const PUT: RequestHandler = async ({ request }) => {
	const next = (await request.json()) as DeckSettings;
	return json(saveSettings(next));
};
