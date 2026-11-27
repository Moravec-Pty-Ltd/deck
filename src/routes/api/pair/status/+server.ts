import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { claimPairing } from '$lib/server/pairing';
import { setAuthCookie } from '$lib/server/config';
import { addDevice } from '$lib/server/devices';

// Public (see PUBLIC_PATHS in hooks.server.ts): the requesting device polls its
// secret. Once an authenticated browser has approved it, this sets the deck_token
// cookie on the requesting device to a credential of its own (devices.ts), which
// can be revoked, and the result is single-use (the record is consumed on read).
export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const secret = url.searchParams.get('secret');
	if (!secret) error(400, 'missing secret');
	const status = claimPairing(secret);
	if (status === 'approved') setAuthCookie(cookies, url.protocol === 'https:', addDevice(request.headers.get('user-agent') ?? 'Paired device').credential);
	return json({ status });
};
