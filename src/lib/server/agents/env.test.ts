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
const { agentTokenSession } = await import('../agent-token');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('agentEnv', () => {
	it('stamps the deck session id', () => {
		expect(agentEnv({ id: 'c_abc123' }, '/tmp').DECK_SESSION_ID).toBe('c_abc123');
	});

	it("stamps the session's own token, never deck's, and the base URL with its trailing slash stripped", () => {
		const stamped = agentEnv({ id: 'c_abc123' }, '/tmp');
		expect(stamped.DECK_TOKEN).toMatch(/^deck-agent\.c_abc123\./);
		expect(agentTokenSession('test-token', stamped.DECK_TOKEN)).toBe('c_abc123');
		// deck read its own token and took it out of the environment children inherit.
		expect(process.env.DECK_TOKEN).toBeUndefined();
		expect(stamped.DECK_DATA).toBeUndefined();
		expect(stamped.DECK_BASE_URL).toBe('http://example.test:4818');
	});

	it('gives a review session no token, even one deck itself was started with', () => {
		const env = agentEnv({ id: 'c_review', prSeeded: true }, '/tmp');
		expect(env.DECK_TOKEN).toBeUndefined();
		expect(env.DECK_SESSION_ID).toBe('c_review');
	});

	it('inherits the parent environment', () => {
		const restore = pinEnv({ DECK_TEST_MARKER: 'present' });
		try {
			expect(agentEnv({ id: 'p_1' }, '/tmp').DECK_TEST_MARKER).toBe('present');
		} finally {
			restore();
		}
	});

	it('points PWD at the spawn cwd rather than deck own', () => {
		expect(agentEnv({ id: 'c_1' }, '/tmp/project').PWD).toBe('/tmp/project');
	});

	it('absolutises a relative cwd', () => {
		expect(path.isAbsolute(agentEnv({ id: 'c_1' }, 'relative/project').PWD!)).toBe(true);
	});

	it('does not mutate process.env', () => {
		const before = process.env.DECK_SESSION_ID;
		agentEnv({ id: 'x_1' }, '/tmp');
		expect(process.env.DECK_SESSION_ID).toBe(before);
	});
});

describe('agentEnv extra', () => {
	it('merges profile env over the base environment', () => {
		const env = agentEnv({ id: 'c_abc123' }, '/tmp', { ANTHROPIC_BASE_URL: 'http://host:1/v1' });
		expect(env.ANTHROPIC_BASE_URL).toBe('http://host:1/v1');
		// Base stamping still applies.
		expect(env.DECK_SESSION_ID).toBe('c_abc123');
	});

	it('leaves the environment untouched when no profile env is given', () => {
		expect(agentEnv({ id: 'c_abc123' }, '/tmp').ANTHROPIC_BASE_URL).toBe(
			process.env.ANTHROPIC_BASE_URL
		);
	});
});
