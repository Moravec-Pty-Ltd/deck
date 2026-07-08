import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { currentUser } from '$lib/server/pr';

// The authenticated gh login, so the client can gate merge to your own PRs (deck
// also captures PRs you're only reviewing). `login` is null when gh can't resolve
// it; the client then falls back to allowing the merge (server enforces the guard).
export const GET: RequestHandler = async () => {
	return json({ login: await currentUser() });
};
