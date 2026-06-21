import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// push.ts derives its data dir from the env at import time (and mints VAPID keys
// there), so pin DECK_DATA to a throwaway dir before the module loads.
const originalDataDir = process.env.DECK_DATA;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-push-'));
process.env.DECK_DATA = tmpDir;

const { isValidPushEndpoint, addSub } = await import('./push');

const SUBS_FILE = path.join(tmpDir, 'push-subscriptions.json');
const sub = (endpoint: string) =>
	({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) as Parameters<typeof addSub>[0];
const readSubs = (): Array<{ endpoint: string }> =>
	JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));

beforeEach(() => {
	fs.rmSync(SUBS_FILE, { force: true });
});

afterAll(() => {
	if (originalDataDir === undefined) delete process.env.DECK_DATA;
	else process.env.DECK_DATA = originalDataDir;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isValidPushEndpoint', () => {
	it('accepts an absolute https URL', () => {
		expect(isValidPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
	});

	it('rejects http and other schemes', () => {
		expect(isValidPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
		expect(isValidPushEndpoint('ftp://example.com/x')).toBe(false);
		expect(isValidPushEndpoint('file:///etc/passwd')).toBe(false);
	});

	it('rejects unparseable, relative, and non-string values', () => {
		expect(isValidPushEndpoint('not a url')).toBe(false);
		expect(isValidPushEndpoint('/relative/path')).toBe(false);
		expect(isValidPushEndpoint(undefined)).toBe(false);
		expect(isValidPushEndpoint(null)).toBe(false);
		expect(isValidPushEndpoint(42)).toBe(false);
		expect(isValidPushEndpoint('')).toBe(false);
	});
});

describe('addSub', () => {
	it('dedupes by endpoint', () => {
		addSub(sub('https://push.example/a'));
		addSub(sub('https://push.example/a'));
		expect(readSubs()).toHaveLength(1);
	});

	it('caps the stored subscriptions, keeping the newest', () => {
		for (let i = 0; i < 30; i++) addSub(sub(`https://push.example/${i}`));
		const stored = readSubs();
		expect(stored).toHaveLength(20);
		// Oldest evicted, newest retained.
		expect(stored[0].endpoint).toBe('https://push.example/10');
		expect(stored.at(-1)?.endpoint).toBe('https://push.example/29');
	});
});
