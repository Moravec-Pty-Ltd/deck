import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';
import { pinEnv } from './test-env';

const dirs = ['data', 'proj'].map((p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `deck-reads-${p}-`))));
const [dataDir, proj] = dirs;
const restoreEnv = pinEnv({ DECK_DATA: dataDir });
fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{ name: 'p', path: proj }]));

let session: DeckSession;
vi.mock('./http', () => ({ sessionOr404: async () => session, objectBody: async (r: Request) => r.json() }));
const { saveFileRoute, serveFileRoute } = await import('./session-reads');

afterAll(() => {
	restoreEnv();
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
	session = { id: 'c_1', kind: 'claude', cwd: proj } as DeckSession;
});

function get(name: string, headers: Record<string, string> = {}) {
	const url = new URL(`http://deck.test/?path=${encodeURIComponent(path.join(proj, name))}`);
	return serveFileRoute({ params: { id: 'c_1' }, url, request: new Request(url, { headers }) });
}

it('streams a whole file or a range, with its length', async () => {
	const bytes = Buffer.alloc(300_000, 'abcdefg');
	fs.writeFileSync(path.join(proj, 'clip.mp4'), bytes);
	const whole = await get('clip.mp4');
	expect(whole.headers.get('content-length')).toBe('300000');
	expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);

	const part = await get('clip.mp4', { range: 'bytes=10-150000' });
	expect(part.status).toBe(206);
	expect(part.headers.get('content-length')).toBe('149991');
	expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 150_001))).toBe(true);
});

it('serves small text with its hash, and an empty file', async () => {
	fs.writeFileSync(path.join(proj, 'a.txt'), 'hi');
	const text = await get('a.txt');
	expect(text.headers.get('x-content-sha256')).toMatch(/^[0-9a-f]{64}$/);
	expect(await text.text()).toBe('hi');
	fs.writeFileSync(path.join(proj, 'empty.bin'), '');
	const empty = await get('empty.bin');
	expect(empty.status).toBe(200);
	expect((await empty.arrayBuffer()).byteLength).toBe(0);
});

it('refuses to save for a remote session', async () => {
	session = { ...session, remote: { target: 'host', path: '/srv/app' } } as DeckSession;
	const request = new Request('http://deck.test/', { method: 'PUT', body: JSON.stringify({ path: 'a.txt', text: 'x', expected: '' }) });
	await expect(saveFileRoute({ params: { id: 'c_1' }, url: new URL(request.url), request })).rejects.toMatchObject({ status: 400 });
});
