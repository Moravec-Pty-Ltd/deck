import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress, publicAddresses, publicGet } from './public-fetch';

describe('isPublicAddress', () => {
	it('takes public addresses only', () => {
		for (const a of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) expect(isPublicAddress(a)).toBe(true);
		for (const a of [
			'127.0.0.1', '10.1.2.3', '100.64.0.1', '100.127.255.254', '169.254.169.254', '172.31.0.1', '192.168.0.1', '0.0.0.0', '224.0.0.1',
			'255.255.255.255', '::1', '::', '::ffff:127.0.0.1', 'fd7a:115c::1', 'fe80::1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:0:1::', 'example.com', ''
		]) {
			expect(isPublicAddress(a), a).toBe(false);
		}
	});
});

describe('publicAddresses', () => {
	const answers = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

	it('refuses a name with any internal address, and an empty answer', async () => {
		expect((await publicAddresses('a.example', answers('8.8.8.8')))[0].address).toBe('8.8.8.8');
		await expect(publicAddresses('a.example', answers('8.8.8.8', '127.0.0.1'))).rejects.toThrow(/not a public/);
		await expect(publicAddresses('a.example', answers())).rejects.toThrow(/not a public/);
		await expect(publicAddresses('127.0.0.1')).rejects.toThrow(/not a public/);
	});
});

describe('publicGet', () => {
	const server = http.createServer((req, res) => {
		if (req.url === '/moved') return void res.writeHead(302, { location: '/ok' }).end();
		if (req.url === '/slow') return;
		if (req.url === '/cut') return void res.writeHead(200, { 'content-length': '50' }).write('x', () => res.destroy());
		res.writeHead(200, { 'content-type': 'image/png' }).end(`${req.headers.host} ${req.headers.authorization}`);
	});
	let port = 0;
	beforeAll(async () => {
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		port = (server.address() as { port: number }).port;
	});
	afterAll(() => {
		server.closeAllConnections();
		server.close();
	});
	const here = async () => [{ address: '127.0.0.1', family: 4 }];
	const opts = { headers: { authorization: 'k' }, timeoutMs: 5000, maxBytes: 1000 };

	it('connects to the checked address, whatever the name resolves to', async () => {
		const res = await publicGet(`http://pinned.invalid:${port}/ok`, opts, here);
		expect(res).toMatchObject({ status: 200, type: 'image/png' });
		expect(res.body.toString()).toBe(`pinned.invalid:${port} k`);
	});

	it('follows no redirect, and stops at the size cap and the deadline', async () => {
		expect((await publicGet(`http://pinned.invalid:${port}/moved`, opts, here)).status).toBe(302);
		await expect(publicGet(`http://pinned.invalid:${port}/ok`, { ...opts, maxBytes: 3 }, here)).rejects.toThrow(/too large/);
		await expect(publicGet(`http://pinned.invalid:${port}/slow`, { ...opts, timeoutMs: 50 }, here)).rejects.toThrow();
	});

	it('settles on an upgrade, a cut-off body and a lookup that never answers', async () => {
		const raw = net.createServer((c) => c.end('HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: x\r\n\r\n'));
		await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
		const at = (raw.address() as { port: number }).port;
		const quick = { ...opts, timeoutMs: 300 };
		await expect(publicGet(`http://pinned.invalid:${at}/`, quick, here)).rejects.toThrow();
		raw.close();
		await expect(publicGet(`http://pinned.invalid:${port}/cut`, opts, here)).rejects.toThrow();
		await expect(publicGet(`http://pinned.invalid:${port}/ok`, quick, () => new Promise(() => {}))).rejects.toThrow();
	});

	it('refuses an internal host outright', async () => {
		await expect(publicGet(`http://127.0.0.1:${port}/ok`, opts)).rejects.toThrow(/not a public/);
		await expect(publicGet(`http://localhost:${port}/ok`, opts)).rejects.toThrow(/not a public/);
	});
});
