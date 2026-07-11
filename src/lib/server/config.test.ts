import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinEnv } from './test-env';

// config.ts derives its data dir and auth token from the env at import time, so
// pin both to known throwaway values before the module loads, then restore after.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir, DECK_TOKEN: 'correct-horse-battery-staple' });

const { tokenMatches, headerToken } = await import('./config');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

	it('returns null when no credential header is present', () => {
		expect(headerToken(new Headers())).toBe(null);
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
