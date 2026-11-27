import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { setAuthCookie } from '$lib/server/config';
import { signInCredential } from '$lib/server/devices';

// Sign in by POST, so the token never sits in a URL, a log or the history.
// deck's token signs this browser in as a new device; a device credential (the
// sign-in QR's) signs it in as that device.
export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const token = String((await request.formData()).get('token') ?? '').trim();
		const credential = signInCredential(token, request.headers.get('user-agent'));
		if (!credential) return fail(400, { wrong: true });
		setAuthCookie(cookies, url.protocol === 'https:', credential);
		redirect(303, '/');
	}
};
