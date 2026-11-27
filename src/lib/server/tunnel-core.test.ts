import { describe, expect, it } from 'vitest';
import { admitTunnel, parseTunnelRequest } from './tunnel-core';

const parse = (query: string) => parseTunnelRequest(new URLSearchParams(query));

describe('parseTunnelRequest', () => {
	it('accepts a port, with an optional session', () => {
		expect(parse('port=5173')).toEqual({ port: 5173 });
		expect(parse('port=1')).toEqual({ port: 1 });
		expect(parse('port=65535&session=abc_1-2')).toEqual({ port: 65535, session: 'abc_1-2' });
	});

	it('refuses ports outside 1 to 65535 or not plain digits', () => {
		for (const q of ['', 'port=', 'port=0', 'port=65536', 'port=-1', 'port=3000.5', 'port=0x50', 'port=%203000', 'port=999999']) {
			expect(parse(q)).toHaveProperty('error');
		}
	});

	it('refuses any destination other than loopback: no host, nor any other parameter', () => {
		expect(parse('port=3000&host=example.com')).toEqual({ error: 'unexpected parameter: host' });
		expect(parse('host=10.0.0.1&port=22')).toHaveProperty('error');
		expect(parse('port=3000&target=example.com')).toHaveProperty('error');
		expect(parse('port=3000&port=4000')).toEqual({ port: 3000 });
	});

	it('refuses a malformed session id', () => {
		expect(parse('port=3000&session=')).toHaveProperty('error');
		expect(parse('port=3000&session=../x')).toHaveProperty('error');
	});
});

describe('admitTunnel', () => {
	const known = (id: string) => (id === 'live' ? { remote: false } : id === 'far' ? { remote: true } : undefined);
	const admit = (authed: boolean, query: string, origin?: string) => admitTunnel(authed, origin, new URLSearchParams(query), known, [4818, 51234]);

	it('refuses a request without a valid deck token, before looking at anything else', () => {
		expect(admit(false, 'port=3000')).toEqual({ status: 401, reason: 'Unauthorized' });
		expect(admit(false, 'port=3000&host=example.com')).toMatchObject({ status: 401 });
	});

	it('refuses a browser (any Origin), even when no token is needed', () => {
		expect(admit(true, 'port=3000', 'https://evil.example')).toEqual({ status: 403, reason: 'Forbidden' });
		expect(admit(true, 'port=3000', 'null')).toMatchObject({ status: 403 });
		expect(admit(false, 'port=3000', 'https://evil.example')).toMatchObject({ status: 401 });
	});

	it('refuses a bad request or an unknown session', () => {
		expect(admit(true, 'port=3000&host=example.com')).toMatchObject({ status: 400 });
		expect(admit(true, 'port=70000')).toMatchObject({ status: 400 });
		expect(admit(true, 'port=3000&session=gone')).toMatchObject({ status: 404 });
	});

	it("refuses deck's own ports on this machine, but not on a remote session's host", () => {
		expect(admit(true, 'port=4818')).toEqual({ status: 403, reason: 'Forbidden' });
		expect(admit(true, 'port=51234&session=live')).toMatchObject({ status: 403 });
		expect(admit(true, 'port=4818&session=far')).toEqual({ port: 4818, session: 'far' });
	});

	it('admits a valid request', () => {
		expect(admit(true, 'port=3000')).toEqual({ port: 3000 });
		expect(admit(true, 'port=3000&session=live')).toEqual({ port: 3000, session: 'live' });
	});
});
