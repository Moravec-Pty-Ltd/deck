import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { pinEnv } from './test-env';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mcp-'));
const restoreEnv = pinEnv({ DECK_DATA: dir });
vi.mock('./store', async (original) => ({
	...(await original<typeof import('./store')>()),
	getStoredSession: (id: string) => (id === 'c_one' || id === 'c_two' ? { id } : undefined)
}));
const { ensureMcp, forgetMcpConfig, mcpConfigFile } = await import('./mcp');

afterAll(() => {
	restoreEnv();
	fs.rmSync(dir, { recursive: true, force: true });
});

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

function config(id: string): { url: string; auth: string } {
	const { url, headers } = JSON.parse(fs.readFileSync(mcpConfigFile(id), 'utf8')).mcpServers.deck;
	return { url, auth: headers.Authorization };
}

function post(url: string, auth: string | undefined, body: unknown = INIT, sid?: string) {
	return fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...(auth ? { authorization: auth } : {}),
			...(sid ? { 'mcp-session-id': sid } : {})
		},
		body: JSON.stringify(body)
	});
}

it('starts afresh over state a hot reload kept from before secrets', async () => {
	(globalThis as { __deckMcp?: unknown }).__deckMcp = { port: 1, ready: Promise.resolve(1) };
	const port = await ensureMcp();
	expect(port).not.toBe(1);
	expect(await ensureMcp()).toBe(port);
	expect(config('c_one').url).toBe(`http://127.0.0.1:${port}/mcp/c_one`);
});

// fetch won't set Host.
function statusFor(url: string, method: string, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		http.request(url, { method, headers }, (res) => {
			res.resume();
			resolve(res.statusCode!);
		}).on('error', reject).end();
	});
}

it('answers only the session a secret was given to', async () => {
	await ensureMcp();
	const one = config('c_one');
	const two = config('c_two');
	expect(one.auth).not.toBe(two.auth);
	expect(config('c_one').auth).toBe(one.auth);

	const opened = await post(one.url, one.auth);
	expect(opened.status).toBe(200);
	const sid = opened.headers.get('mcp-session-id')!;
	await opened.text();

	expect((await post(one.url, undefined)).status).toBe(403);
	expect((await post(one.url, two.auth)).status).toBe(403);
	const gone = config('c_gone');
	expect((await post(gone.url, gone.auth)).status).toBe(403);
	expect((await post(one.url.replace('c_one', '%'), one.auth)).status).toBe(404);

	expect(await statusFor(one.url, 'POST', { host: 'deck.example.com', authorization: one.auth })).toBe(403);
	for (const method of ['GET', 'DELETE']) expect(await statusFor(one.url, method, { 'mcp-session-id': sid })).toBe(403);

	const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
	const listed = await post(one.url, one.auth, list, sid);
	expect(listed.status).toBe(200);
	await listed.text();
	// Another session's secret does not reach the first one's connection.
	expect((await post(two.url, two.auth, list, sid)).status).toBe(400);
});

it('keeps the config private and removes it with the session', () => {
	const file = mcpConfigFile('c_one');
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
	forgetMcpConfig('c_one');
	expect(fs.existsSync(file)).toBe(false);
});
