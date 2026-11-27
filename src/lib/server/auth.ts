import type { Cookies } from '@sveltejs/kit';
import { AUTH_COOKIE, headerToken, tokenMatches } from './config';
import { deviceForCredential } from './devices';

// Does this request already carry a valid credential - deck's token or a
// device's own, in a header (programmatic clients, the apps) or the session
// cookie (browsers)? Shared by the request hook and the root layout load so the
// check lives in one place (issue #164).
export function requestIsAuthed(headers: Headers, cookies: Cookies): boolean {
	return credentialValid(headerToken(headers)) || credentialValid(cookies.get(AUTH_COOKIE));
}

// deck's token, or a signed-in device's own credential.
export function credentialValid(candidate: string | null | undefined): boolean {
	return tokenMatches(candidate) || !!deviceForCredential(candidate);
}
