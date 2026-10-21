import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinEnv } from './test-env';

// The issue-source routes end to end over a throwaway data dir, an in-memory
// keyring and a stubbed fetch, so nothing reaches the real keyring or a real
// provider. The point of most of these is that a key goes in and never comes
// back out.
const KEY = 'lin_api_secret_value_123';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-issue-source-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir });

const keyring = vi.hoisted(() => new Map<string, string>());
vi.mock('./secrets', () => ({
	readSecret: (id: string) => keyring.get(id),
	setSecret: (id: string, key: string) => void keyring.set(id, key),
	deleteSecret: (id: string) => void keyring.delete(id)
}));

const { addSourceRoute, removeSourceRoute, credentialsRoute, sourceLookupRoute } = await import('./issue-source');

const PROJECT = '/path/to/project';

function post(body: unknown): { request: Request } {
	return { request: new Request('http://deck/x', { method: 'POST', body: JSON.stringify(body) }) };
}

function at(query: string): { url: URL } {
	return { url: new URL(`http://deck/x?${query}`) };
}

async function rejection(run: () => Promise<unknown>): Promise<{ status: number; message: string }> {
	try {
		await run();
	} catch (e) {
		const err = e as { status: number; body?: { message?: string } };
		return { status: err.status, message: err.body?.message ?? '' };
	}
	throw new Error('expected a rejection');
}

const linearBody = (over: Record<string, unknown> = {}) => ({
	projectPath: PROJECT,
	type: 'linear',
	teamId: 'team-1',
	teamName: 'Engineering',
	assigneeEmail: 'someone@example.com',
	apiKey: KEY,
	...over
});

beforeEach(() => {
	keyring.clear();
	fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify([{ name: 'example', path: PROJECT, sources: [] }]));
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('adding and removing a source', () => {
	it('stores the key in the keyring and returns a source without it', async () => {
		const res = await addSourceRoute(post(linearBody()));
		expect(res.status).toBe(201);
		const text = await res.text();
		expect(text).not.toContain(KEY);
		const source = JSON.parse(text);
		expect(keyring.get(source.credentialId)).toBe(KEY);
		expect(fs.readFileSync(path.join(tmpDir, 'projects.json'), 'utf8')).not.toContain(KEY);
	});

	it('lists the saved key by label only', async () => {
		await addSourceRoute(post(linearBody()));
		const text = await (await credentialsRoute(at('type=linear'))).text();
		expect(text).not.toContain(KEY);
		expect(JSON.parse(text)).toEqual([
			expect.objectContaining({ type: 'linear', label: 'someone@example.com', projects: ['example'] })
		]);
		expect(await (await credentialsRoute(at('type=clickup'))).json()).toEqual([]);
	});

	it('reuses a saved key without writing it again', async () => {
		const first = await (await addSourceRoute(post(linearBody()))).json();
		keyring.set('sentinel', 'untouched');
		const reused = await (await addSourceRoute(post(linearBody({ apiKey: undefined, credentialId: first.credentialId })))).json();
		expect(reused.credentialId).toBe(first.credentialId);
		expect([...keyring.keys()].sort()).toEqual([first.credentialId, 'sentinel'].sort());
	});

	it('404s for an unregistered project', async () => {
		expect(await rejection(() => addSourceRoute(post(linearBody({ projectPath: '/elsewhere' }))))).toEqual({
			status: 404,
			message: 'project not found'
		});
		expect(keyring.size).toBe(0);
	});

	it('removes the source and its now-unused key', async () => {
		const source = await (await addSourceRoute(post(linearBody()))).json();
		const res = await removeSourceRoute(at(`project=${encodeURIComponent(PROJECT)}&id=${source.id}`));
		expect(await res.json()).toEqual({ ok: true });
		expect(keyring.size).toBe(0);
		expect(await (await credentialsRoute(at(''))).json()).toEqual([]);
	});

	it('rejects a removal missing its params or naming no project', async () => {
		expect((await rejection(() => removeSourceRoute(at('id=x')))).status).toBe(400);
		expect((await rejection(() => removeSourceRoute(at('project=/elsewhere&id=x')))).status).toBe(404);
	});
});

describe('provider lookups', () => {
	function stubFetch(status: number, body: string) {
		const fetch = vi.fn(async () => new Response(body, { status }));
		vi.stubGlobal('fetch', fetch);
		return fetch;
	}

	it('proxies a lookup with a saved key the request only names', async () => {
		const source = await (await addSourceRoute(post(linearBody()))).json();
		const fetch = stubFetch(200, JSON.stringify({ data: { teams: { nodes: [{ id: 't', name: 'Eng', key: 'ENG' }] } } }));
		const res = await sourceLookupRoute(post({ type: 'linear', action: 'teams', credentialId: source.credentialId }));
		const text = await res.text();
		expect(JSON.parse(text)).toEqual([{ id: 't', name: 'Eng', key: 'ENG' }]);
		expect(text).not.toContain(KEY);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('keeps the key out of a provider error that quotes it', async () => {
		stubFetch(401, `{"error":"invalid key ${KEY}"}`);
		const { status, message } = await rejection(() => sourceLookupRoute(post({ type: 'linear', action: 'me', apiKey: KEY })));
		expect(status).toBe(400);
		expect(message).toContain('Linear API 401');
		expect(message).not.toContain(KEY);
	});

	it('rejects an unknown action before touching a key or the network', async () => {
		const fetch = stubFetch(200, '{}');
		expect(await rejection(() => sourceLookupRoute(post({ type: 'linear', action: 'drop', apiKey: KEY })))).toEqual({
			status: 400,
			message: 'unknown type/action'
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});
