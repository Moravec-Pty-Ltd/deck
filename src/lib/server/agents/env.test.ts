import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinEnv } from '../test-env';

// env.ts pulls the auth token and base URL from config.ts, which derives them
// from the env at import time; pin throwaway values before the module loads.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-env-'));
const restoreEnv = pinEnv({
	DECK_DATA: tmpDir,
	DECK_TOKEN: 'test-token',
	DECK_BASE_URL: 'http://example.test:4818/'
});

const { agentEnv } = await import('./env');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('agentEnv', () => {
	it('stamps the deck session id', () => {
		expect(agentEnv('c_abc123').DECK_SESSION_ID).toBe('c_abc123');
	});

	it('stamps the API credentials, base URL trailing slash stripped', () => {
		const env = agentEnv('c_abc123');
		expect(env.DECK_TOKEN).toBe('test-token');
		expect(env.DECK_BASE_URL).toBe('http://example.test:4818');
	});

	it('inherits the parent environment', () => {
		const restore = pinEnv({ DECK_TEST_MARKER: 'present' });
		try {
			expect(agentEnv('p_1').DECK_TEST_MARKER).toBe('present');
		} finally {
			restore();
		}
	});

	it('does not mutate process.env', () => {
		const before = process.env.DECK_SESSION_ID;
		agentEnv('x_1');
		expect(process.env.DECK_SESSION_ID).toBe(before);
	});
});
