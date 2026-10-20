import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentApiError, agentDelete, agentGet, agentPath, agentPost, agentRequest, sessionPath } from './agent-api';

function stub(status: number, body?: unknown) {
	const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
	return vi.fn(async () => new Response(status === 204 ? null : text, { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe('paths', () => {
	it('encodes each session path segment', () => {
		expect(sessionPath('c 1')).toBe('/api/agent/sessions/c%201');
		expect(sessionPath('c1', 'images', 'a b.png')).toBe('/api/agent/sessions/c1/images/a%20b.png');
	});

	it('roots a top-level path under /api/agent', () => {
		expect(agentPath('user')).toBe('/api/agent/user');
		expect(agentPath('/projects/hidden')).toBe('/api/agent/projects/hidden');
	});
});

describe('agentRequest', () => {
	it('GETs and parses JSON', async () => {
		const f = stub(200, { login: 'octocat' });
		await expect(agentGet('/api/agent/user', f)).resolves.toEqual({ login: 'octocat' });
		expect(f).toHaveBeenCalledWith('/api/agent/user', { method: 'GET' });
	});

	it('POSTs a JSON body, an empty object by default', async () => {
		const f = stub(200, { ok: true });
		vi.stubGlobal('fetch', f);
		await agentPost('/api/agent/sessions/c1/restart');
		expect(f).toHaveBeenCalledWith('/api/agent/sessions/c1/restart', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
	});

	it('DELETEs with an optional body', async () => {
		const f = stub(200, { ok: true });
		vi.stubGlobal('fetch', f);
		await agentDelete('/api/agent/sessions/c1/pr');
		expect(f).toHaveBeenCalledWith('/api/agent/sessions/c1/pr', { method: 'DELETE' });
		await agentDelete('/api/agent/sessions/c1', { deleteWorktree: true });
		expect(f).toHaveBeenLastCalledWith('/api/agent/sessions/c1', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: '{"deleteWorktree":true}'
		});
	});

	it('resolves undefined for an empty body', async () => {
		await expect(agentRequest('/api/agent/x', { fetch: stub(204) })).resolves.toBeUndefined();
	});

	it('throws the server message with the status', async () => {
		const res = agentRequest('/api/agent/x', { fetch: stub(409, { message: 'a turn is running' }) });
		await expect(res).rejects.toBeInstanceOf(AgentApiError);
		await expect(res).rejects.toMatchObject({ message: 'a turn is running', status: 409 });
	});

	it('falls back to the status when the error has no message', async () => {
		await expect(agentRequest('/api/agent/x', { fetch: stub(500, 'oops') })).rejects.toThrow('request failed (500)');
		await expect(agentRequest('/api/agent/x', { fetch: stub(400, { message: '  ' }) })).rejects.toThrow('request failed (400)');
	});
});
