import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckSession } from '$lib/types';
import { pinEnv } from './test-env';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-session-upload-'));
const restoreEnv = pinEnv({ DECK_DATA: dataDir });

let session: DeckSession;
const sent = vi.fn();

vi.mock('./http', () => ({
	sessionOr404: async () => session,
	objectBody: async (request: Request) => request.json()
}));
vi.mock('./send-agent-message', () => ({
	sendAgentMessage: async (...args: unknown[]) => sent(...args)
}));

const { uploadToSession } = await import('./session-upload');

afterAll(() => {
	restoreEnv();
	fs.rmSync(dataDir, { recursive: true, force: true });
});

const uploads = path.join(dataDir, 'uploads');
const image = { media_type: 'image/png', data: 'aGVsbG8=' };
const files = [{ name: 'notes.txt', data: Buffer.from('hello').toString('base64') }];

function upload(body: unknown) {
	const request = new Request('http://deck.test/', { method: 'POST', body: JSON.stringify(body) });
	return uploadToSession({ params: { id: session.id }, request });
}

function written(): string[] {
	return fs.existsSync(uploads) ? fs.readdirSync(uploads, { recursive: true }).map(String) : [];
}

beforeEach(() => {
	fs.rmSync(uploads, { recursive: true, force: true });
	sent.mockReset();
});

describe('uploadToSession', () => {
	it('refuses images for a non-claude session before writing anything', async () => {
		session = { id: 'x_codex', kind: 'codex', title: 't', cwd: '/path/to/project', status: 'idle', createdAt: 1, lastActiveAt: 1 } as DeckSession;
		await expect(upload({ files, images: [image] })).rejects.toMatchObject({
			status: 400,
			body: { message: 'image attachments require a claude session' }
		});
		expect(written()).toEqual([]);
		expect(sent).not.toHaveBeenCalled();
	});

	it('writes the files and sends one turn with the images to a claude session', async () => {
		session = { id: 'c_claude', kind: 'claude', title: 't', cwd: '/path/to/project', status: 'idle', createdAt: 1, lastActiveAt: 1 } as DeckSession;
		const res = await upload({ files, images: [image], text: 'look' });
		expect((await res.json()).files).toHaveLength(1);
		expect(written().some((f) => f.endsWith('notes.txt'))).toBe(true);
		expect(sent).toHaveBeenCalledWith(session, expect.objectContaining({ images: [image] }));
	});

	it('shares plain files with a non-claude session', async () => {
		session = { id: 'x_codex', kind: 'codex', title: 't', cwd: '/path/to/project', status: 'idle', createdAt: 1, lastActiveAt: 1 } as DeckSession;
		expect((await upload({ files })).status).toBe(200);
		expect(written().some((f) => f.endsWith('notes.txt'))).toBe(true);
	});
});
