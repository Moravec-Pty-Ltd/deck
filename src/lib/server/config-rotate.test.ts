import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinEnv } from './test-env';

// A token from the token file, not DECK_TOKEN, so it can be rotated.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-rotate-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir, DECK_TOKEN: undefined });
const config = await import('./config');
const { addDevice } = await import('./devices');
const { credentialValid } = await import('./auth');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('rotates the token: the old one stops working, devices stay signed in', () => {
	const old = config.authToken;
	const { credential } = addDevice('Laptop');
	config.rotateToken();
	expect(config.tokenMatches(old)).toBe(false);
	expect(config.tokenMatches(config.authToken)).toBe(true);
	expect(fs.readFileSync(path.join(tmpDir, 'token'), 'utf8')).toBe(config.authToken);
	expect(fs.statSync(path.join(tmpDir, 'token')).mode & 0o777).toBe(0o600);
	expect(credentialValid(credential)).toBe(true);
});
