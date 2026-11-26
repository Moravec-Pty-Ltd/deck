import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	canStart,
	canStop,
	isInFlight,
	isLoopbackUrl,
	serverActionPath,
	serverLogsPath,
	sessionServersPath,
	serverAction,
	fetchServers
} from './servers-client';
import type { ServerState } from './types';

const ALL: ServerState[] = ['stopped', 'setup', 'starting', 'running', 'stalled', 'errored', 'dead'];

describe('server state predicates', () => {
	it('canStart is true only for settled off states', () => {
		expect(ALL.filter(canStart)).toEqual(['stopped', 'errored', 'dead']);
	});

	it('canStop is the complement of canStart', () => {
		for (const s of ALL) expect(canStop(s)).toBe(!canStart(s));
	});

	it('isInFlight covers setup and starting', () => {
		expect(ALL.filter(isInFlight)).toEqual(['setup', 'starting']);
	});
});

describe('isLoopbackUrl', () => {
	it.each([
		'http://localhost:5173/app',
		'http://LOCALHOST:3000',
		'http://127.0.0.1:3000',
		'http://127.1.2.3:3000',
		'http://[::1]:8080/',
		'https://tenant.localhost:3000',
		'http://0.0.0.0:3000'
	])('%s is loopback', (url) => expect(isLoopbackUrl(url)).toBe(true));

	it.each([
		'http://192.168.1.20:3000',
		'http://10.0.0.5:3000',
		'https://example.com',
		'http://localhost.example.com',
		'http://127.0.0.1.example.com',
		'http://notlocalhost:3000',
		'not a url'
	])('%s is not', (url) => expect(isLoopbackUrl(url)).toBe(false));
});

describe('serverActionPath', () => {
	it('encodes the session id and server name', () => {
		expect(serverActionPath('s 1', 'web/app')).toBe('/api/agent/sessions/s%201/servers/web%2Fapp');
	});

	it('builds the list and logs paths on the agent API', () => {
		expect(sessionServersPath('s 1')).toBe('/api/agent/sessions/s%201/servers');
		expect(serverLogsPath('s 1', 'web/app')).toBe('/api/agent/sessions/s%201/servers/web%2Fapp/logs');
	});
});

describe('serverAction', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('POSTs the action and resolves on ok', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
		vi.stubGlobal('fetch', fetchMock);
		await serverAction('s1', 'web', 'start');
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/agent/sessions/s1/servers/web',
			expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'start' }) })
		);
	});

	it('throws the endpoint message on failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: false, json: async () => ({ message: 'port in use' }) })
		);
		await expect(serverAction('s1', 'web', 'restart')).rejects.toThrow('port in use');
	});
});

describe('fetchServers', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('returns the servers array, or [] when absent', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [{ name: 'web' }] }) }));
		expect(await fetchServers('s1')).toEqual([{ name: 'web' }]);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
		expect(await fetchServers('s1')).toEqual([]);
	});

	it('throws on a non-ok response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
		await expect(fetchServers('s1')).rejects.toThrow('request failed (500)');
	});
});
