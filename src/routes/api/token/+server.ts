import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authToken } from '$lib/server/config';

// The access token, for an already-authenticated browser to render a sign-in QR
// (the deck_token cookie is httpOnly, so client JS can't read the secret it already
// carries). Only reachable through the auth gate - it hands back the same credential
// the requesting browser already holds.
export const GET: RequestHandler = async () => {
	return json({ token: authToken });
};
