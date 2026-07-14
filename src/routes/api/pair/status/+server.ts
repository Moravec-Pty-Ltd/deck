import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { claimPairing } from '$lib/server/pairing';
import { setAuthCookie } from '$lib/server/config';

// Public (see PUBLIC_PATHS in hooks.server.ts): the requesting device polls its
// secret. Once an authenticated browser has approved it, this sets the deck_token
// cookie on the requesting device - so the raw token is never shown to it - and the
// result is single-use (the record is consumed on read).
export const GET: RequestHandler = async ({ url, cookies }) => {
	const secret = url.searchParams.get('secret');
	if (!secret) error(400, 'missing secret');
	const status = claimPairing(secret);
	if (status === 'approved') setAuthCookie(cookies, url.protocol === 'https:');
	return json({ status });
};
