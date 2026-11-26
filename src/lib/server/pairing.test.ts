import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { pinEnv } from './test-env';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pairing-'));
const restoreEnv = pinEnv({ DECK_DATA: dir });
const pushed = vi.hoisted(() => [] as unknown[]);
const events = vi.hoisted(() => [] as unknown[]);
vi.mock('./push', () => ({ notify: (n: unknown) => pushed.push(n) }));
vi.mock('./agent-feed', () => ({ publishAgentEvent: (...e: unknown[]) => events.push(e) }));
const { claimPairing, decidePairing, listPending, requestPairing } = await import('./pairing');

afterAll(() => {
	restoreEnv();
	fs.rmSync(dir, { recursive: true, force: true });
});

it('shows the code only to the device that asked, and takes it to approve', () => {
	const asked = requestPairing();
	expect(asked.code).toMatch(/^\d{6}$/);
	const [{ id, code }] = listPending();
	expect(code).toBe('');
	expect(JSON.stringify([pushed, events])).not.toContain(asked.code);

	expect(decidePairing(id, { code: 'nope' })).toBe('wrong-code');
	expect(claimPairing(asked.secret)).toBe('pending');
	expect(decidePairing(id, { code: asked.code })).toBe('ok');
	expect(claimPairing(asked.secret)).toBe('approved');
	expect(claimPairing(asked.secret)).toBe('unknown');
	expect(decidePairing(id, null)).toBe('gone');
});

it('refuses requests past the rate', () => {
	for (let i = 0; i < 4; i++) requestPairing();
	expect(() => requestPairing()).toThrow(expect.objectContaining({ status: 429 }));
	expect(listPending()).toHaveLength(4);
});
