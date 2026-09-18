import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-search-test-'));
process.env.DECK_DATA = dataDir;

const mocks = vi.hoisted(() => ({ sessions: vi.fn() }));
vi.mock('./store', async (importOriginal) => ({ ...(await importOriginal<typeof import('./store')>()), listStoredSessions: mocks.sessions }));
const { transcriptPath } = await import('./transcript');
const { searchTranscripts } = await import('./search');
const { GET } = await import('../../routes/api/search/+server');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const seed = (id: string, events: unknown[]) =>
	fs.writeFileSync(transcriptPath(id), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

beforeEach(() => {
	vi.resetAllMocks();
	seed('a', [
		{ type: 'deck.user', text: 'Please fix the auth middleware', ts: 5 },
		{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'auth' } }] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', content: 'auth.ts: 40 matches' }] } },
		{ type: 'assistant', message: { content: [{ type: 'text', text: 'The AUTH check now runs first.' }] } }
	]);
	seed('b', [{ type: 'deck.user', text: 'unrelated', ts: 1 }]);
	mocks.sessions.mockReturnValue([
		{ id: 'b', kind: 'claude', title: 'Other', lastActiveAt: 2 },
		{ id: 'a', kind: 'claude', title: 'Auth work', lastActiveAt: 9 },
		{ id: 'shell', kind: 'shell', title: 'sh', lastActiveAt: 99 }
	]);
});

it('finds prompts and replies, newest session first, skipping tool output', async () => {
	const { hits, truncated } = await searchTranscripts('auth', 10);
	expect(truncated).toBe(false);
	expect(hits.map((h) => [h.sessionId, h.index, h.role])).toEqual([['a', 0, 'user'], ['a', 3, 'assistant']]);
	expect(hits[0].snippet).toBe('Please fix the auth middleware');
	expect(hits[0].at).toBe(5);
	expect(hits[1].title).toBe('Auth work');
});

it('caps the result count', async () => {
	const { hits, truncated } = await searchTranscripts('auth', 1);
	expect(hits).toHaveLength(1);
	expect(truncated).toBe(true);
});

it('serves the route and rejects short queries', async () => {
	const body = await (await GET({ url: new URL('http://example.test/api/search?q=%20auth%20&limit=5') } as Parameters<typeof GET>[0])).json();
	expect(body.query).toBe('auth');
	expect(body.hits).toHaveLength(2);
	await expect(GET({ url: new URL('http://example.test/api/search?q=a') } as Parameters<typeof GET>[0])).rejects.toMatchObject({ status: 400 });
});
