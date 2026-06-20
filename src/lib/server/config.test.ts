import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.ts derives its data dir and auth token from the env at import time, so
// pin both to known throwaway values before the module loads, then restore after.
const originalDataDir = process.env.DECK_DATA;
const originalToken = process.env.DECK_TOKEN;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-'));
process.env.DECK_DATA = tmpDir;
process.env.DECK_TOKEN = 'correct-horse-battery-staple';

const { tokenMatches } = await import('./config');

afterAll(() => {
	if (originalDataDir === undefined) delete process.env.DECK_DATA;
	else process.env.DECK_DATA = originalDataDir;
	if (originalToken === undefined) delete process.env.DECK_TOKEN;
	else process.env.DECK_TOKEN = originalToken;
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

describe('loadToken', () => {
	it('mints a fresh token when the token file is empty/whitespace', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-empty-'));
		fs.writeFileSync(path.join(dir, 'token'), '   \n');
		const prevData = process.env.DECK_DATA;
		const prevToken = process.env.DECK_TOKEN;
		process.env.DECK_DATA = dir;
		delete process.env.DECK_TOKEN;
		vi.resetModules();
		try {
			const mod = await import('./config');
			// An empty file must not yield an empty (any-credential) token.
			expect(mod.authToken).not.toBe('');
			expect(mod.tokenMatches('')).toBe(false);
			expect(mod.tokenMatches(mod.authToken)).toBe(true);
		} finally {
			process.env.DECK_DATA = prevData;
			if (prevToken === undefined) delete process.env.DECK_TOKEN;
			else process.env.DECK_TOKEN = prevToken;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
