import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinEnv } from './test-env';

// config.ts derives its data dir and auth token from the env at import time, so
// pin both to known throwaway values before the module loads, then restore after.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir, DECK_TOKEN: 'correct-horse-battery-staple' });

const { tokenMatches, headerToken, requestIsAuthed, isPrivateHost, AUTH_COOKIE } = await import(
	'./config'
);

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A minimal Cookies stand-in: only .get is exercised by requestIsAuthed.
function fakeCookies(value?: string): Parameters<typeof requestIsAuthed>[1] {
	return { get: (name: string) => (name === AUTH_COOKIE ? value : undefined) } as unknown as Parameters<
		typeof requestIsAuthed
	>[1];
}

describe('tokenMatches', () => {
	it('accepts the exact token', () => {
		expect(tokenMatches('correct-horse-battery-staple')).toBe(true);
	});

	it('rejects a wrong token', () => {
		expect(tokenMatches('wrong-horse-battery-staple')).toBe(false);
	});

	it('rejects a correct prefix (no early-out match)', () => {
		expect(tokenMatches('correct-horse-battery-stapl')).toBe(false);
		expect(tokenMatches('correct')).toBe(false);
	});

	it('rejects a longer string that starts with the token', () => {
		expect(tokenMatches('correct-horse-battery-staple-extra')).toBe(false);
	});

	it('rejects null, undefined and empty', () => {
		expect(tokenMatches(null)).toBe(false);
		expect(tokenMatches(undefined)).toBe(false);
		expect(tokenMatches('')).toBe(false);
	});
});

describe('headerToken', () => {
	it('extracts a bearer token, case-insensitive scheme', () => {
		expect(headerToken(new Headers({ authorization: 'Bearer abc' }))).toBe('abc');
		expect(headerToken(new Headers({ authorization: 'bearer abc' }))).toBe('abc');
	});

	it('falls back to X-Deck-Token', () => {
		expect(headerToken(new Headers({ 'x-deck-token': 'xyz' }))).toBe('xyz');
	});

	it('prefers the Authorization header when both are present', () => {
		const headers = new Headers({ authorization: 'Bearer abc', 'x-deck-token': 'xyz' });
		expect(headerToken(headers)).toBe('abc');
	});

	it('ignores non-bearer Authorization schemes', () => {
		expect(headerToken(new Headers({ authorization: 'Basic dXNlcg==' }))).toBe(null);
	});

	it('trims X-Deck-Token and treats a blank one as missing', () => {
		expect(headerToken(new Headers({ 'x-deck-token': ' xyz ' }))).toBe('xyz');
		expect(headerToken(new Headers({ 'x-deck-token': '   ' }))).toBe(null);
	});

	it('returns null when no credential header is present', () => {
		expect(headerToken(new Headers())).toBe(null);
	});
});

describe('requestIsAuthed', () => {
	it('accepts a valid header token', () => {
		const headers = new Headers({ authorization: 'Bearer correct-horse-battery-staple' });
		expect(requestIsAuthed(headers, fakeCookies())).toBe(true);
	});

	it('accepts a valid session cookie', () => {
		expect(requestIsAuthed(new Headers(), fakeCookies('correct-horse-battery-staple'))).toBe(true);
	});

	it('rejects when neither header nor cookie carries the token', () => {
		expect(requestIsAuthed(new Headers(), fakeCookies())).toBe(false);
		expect(requestIsAuthed(new Headers({ 'x-deck-token': 'nope' }), fakeCookies('nope'))).toBe(false);
	});
});

describe('isPrivateHost', () => {
	it('treats loopback and localhost as private', () => {
		for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.5.6.7', '::1', '[::1]'])
			expect(isPrivateHost(h)).toBe(true);
	});

	it('treats Tailscale addresses as private', () => {
		for (const h of ['box.ts.net', 'BOX.TS.NET', '100.64.0.1', '100.100.0.12', '100.127.255.255'])
			expect(isPrivateHost(h)).toBe(true);
	});

	it('treats RFC1918 and link-local as private', () => {
		for (const h of ['10.0.0.1', '192.168.1.5', '172.16.0.1', '172.31.255.255', '169.254.1.1'])
			expect(isPrivateHost(h)).toBe(true);
	});

	it('treats IPv6 link-local (across fe80::/10) and unique-local as private', () => {
		for (const h of ['fe80::1', 'fe9a::1', 'feb0::1', 'fc00::1', 'fd12:3456::1'])
			expect(isPrivateHost(h)).toBe(true);
	});

	it('treats public hosts and out-of-range IPs as not private', () => {
		for (const h of [
			'deck.example.com',
			'8.8.8.8',
			'203.0.113.5',
			'172.15.0.1', // just below the RFC1918 172.16-31 band
			'172.32.0.1', // just above it
			'100.63.0.1', // just below the CGNAT 100.64-127 band
			'100.128.0.1', // just above it
			'fc-barcelona.com', // a hostname, not an fc00::/7 IPv6 literal
			'fec0::1', // deprecated site-local, outside the link-local /10
			''
		])
			expect(isPrivateHost(h)).toBe(false);
	});
});

describe('noAuth guardrail (#163)', () => {
	// Re-import config under pinned env so the module-load guardrail runs fresh.
	async function loadNoAuth(env: Record<string, string | undefined>): Promise<boolean> {
		const restore = pinEnv({
			DECK_DATA: tmpDir,
			DECK_TOKEN: 'x',
			DECK_NO_AUTH: undefined,
			DECK_NO_AUTH_PUBLIC: undefined,
			DECK_DEMO: undefined,
			DECK_BASE_URL: undefined,
			...env
		});
		vi.resetModules();
		try {
			return (await import('./config')).noAuth;
		} finally {
			restore();
		}
	}

	it('honours DECK_NO_AUTH on a private host', async () => {
		expect(await loadNoAuth({ DECK_NO_AUTH: '1', DECK_BASE_URL: 'http://localhost:4818' })).toBe(true);
		expect(await loadNoAuth({ DECK_NO_AUTH: '1', DECK_BASE_URL: 'https://box.ts.net:4818' })).toBe(true);
		expect(await loadNoAuth({ DECK_NO_AUTH: '1', DECK_BASE_URL: 'http://100.100.0.12:4818' })).toBe(true);
		// Scheme-less base URL: the host parse must fall back to the http:// form.
		expect(await loadNoAuth({ DECK_NO_AUTH: '1', DECK_BASE_URL: 'localhost:4818' })).toBe(true);
	});

	it('ignores DECK_NO_AUTH on a public host and warns', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await loadNoAuth({ DECK_NO_AUTH: '1', DECK_BASE_URL: 'https://deck.example.com' })).toBe(false);
		expect(err).toHaveBeenCalled();
		err.mockRestore();
	});

	it('honours DECK_NO_AUTH on a public host when DECK_NO_AUTH_PUBLIC=1', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(
			await loadNoAuth({
				DECK_NO_AUTH: '1',
				DECK_NO_AUTH_PUBLIC: '1',
				DECK_BASE_URL: 'https://deck.example.com'
			})
		).toBe(true);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('leaves the gate on when DECK_NO_AUTH is unset, and off for demo mode', async () => {
		expect(await loadNoAuth({ DECK_BASE_URL: 'https://deck.example.com' })).toBe(false);
		expect(await loadNoAuth({ DECK_DEMO: '1', DECK_BASE_URL: 'https://deck.example.com' })).toBe(true);
	});
});

describe('loadToken', () => {
	it('mints a fresh token when the token file is empty/whitespace', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-empty-'));
		fs.writeFileSync(path.join(dir, 'token'), '   \n');
		const restore = pinEnv({ DECK_DATA: dir, DECK_TOKEN: undefined });
		vi.resetModules();
		try {
			const mod = await import('./config');
			// An empty file must not yield an empty (any-credential) token.
			expect(mod.authToken).not.toBe('');
			expect(mod.tokenMatches('')).toBe(false);
			expect(mod.tokenMatches(mod.authToken)).toBe(true);
		} finally {
			restore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
