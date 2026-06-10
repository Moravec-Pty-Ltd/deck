import type { Handle } from '@sveltejs/kit';
import { redirect, json } from '@sveltejs/kit';
import { authToken, noAuth, printAccessUrl } from '$lib/server/config';

const COOKIE = 'deck_token';

export const handle: Handle = async ({ event, resolve }) => {
	printAccessUrl(event.url.origin);

	if (noAuth) return resolve(event);

	const urlToken = event.url.searchParams.get('token');
	if (urlToken === authToken) {
		event.cookies.set(COOKIE, authToken, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: event.url.protocol === 'https:',
			maxAge: 60 * 60 * 24 * 365
		});
		const clean = new URL(event.url);
		clean.searchParams.delete('token');
		redirect(302, clean.pathname + clean.search);
	}

	const authed = event.cookies.get(COOKIE) === authToken;
	if (!authed && event.url.pathname !== '/login') {
		if (event.url.pathname.startsWith('/api/')) {
			return json({ error: 'unauthorized' }, { status: 401 });
		}
		redirect(302, '/login');
	}

	return resolve(event);
};
