import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A registered project holding a fresh morabot status.json, wired up through the
// env before the module loads (config reads DECK_MORABOT_STATUS at import).
const scratch = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `deck-morabot-${p}-`)));
const [dataDir, projRoot] = ['data', 'proj'].map(scratch);
const prev = { data: process.env.DECK_DATA, status: process.env.DECK_MORABOT_STATUS };
process.env.DECK_DATA = dataDir;
const statusFile = path.join(projRoot, '.morabot', 'status.json');
process.env.DECK_MORABOT_STATUS = statusFile;
fs.mkdirSync(path.dirname(statusFile), { recursive: true });
fs.writeFileSync(statusFile, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), recent: [] }));
fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{ name: 'p', path: projRoot }]));

vi.mock('./push', () => ({ notify: vi.fn() }));

afterAll(() => {
	for (const [key, value] of [
		['DECK_DATA', prev.data],
		['DECK_MORABOT_STATUS', prev.status]
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete (globalThis as { __deckMorabot?: unknown }).__deckMorabot;
	for (const d of [dataDir, projRoot]) fs.rmSync(d, { recursive: true, force: true });
});

describe('morabot poll state', () => {
	it('is shared across module instances, so a poll from one is seen by the next (HMR)', async () => {
		const first = await import('./morabot');
		expect(first.cachedReviews().status).toBe('offline');
		first.pollMorabot([]);
		expect(first.cachedReviews().status).toBe('ok');

		// What Vite does on a hot reload: a fresh evaluation of the module while
		// the monitor's interval still holds the old pollMorabot.
		vi.resetModules();
		const second = await import('./morabot');
		expect(second).not.toBe(first);
		expect(second.cachedReviews().status).toBe('ok');

		fs.writeFileSync(statusFile, JSON.stringify({ version: 1, updatedAt: new Date(Date.now() + 1000).toISOString(), recent: [] }));
		const future = Date.now() + 1000;
		fs.utimesSync(statusFile, future / 1000, future / 1000);
		first.pollMorabot([]);
		expect(second.cachedReviews().updatedAt).toBe(first.cachedReviews().updatedAt);
	});
});
