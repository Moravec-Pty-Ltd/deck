import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	canStart,
	canStop,
	isInFlight,
	serverActionPath,
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

describe('serverActionPath', () => {
	it('encodes the session id and server name', () => {
		expect(serverActionPath('s 1', 'web/app')).toBe('/api/sessions/s%201/servers/web%2Fapp');
	});
});

describe('serverAction', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('POSTs the action and resolves on ok', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
		vi.stubGlobal('fetch', fetchMock);
		await serverAction('s1', 'web', 'start');
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sessions/s1/servers/web',
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
