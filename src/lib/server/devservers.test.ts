import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { probePort } from './devservers';

const open: net.Server[] = [];

function listen(host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		open.push(srv);
		srv.once('error', reject);
		srv.listen(0, host, () => {
			const addr = srv.address();
			if (addr && typeof addr === 'object') resolve(addr.port);
			else reject(new Error('no port assigned'));
		});
	});
}

function close(srv: net.Server): Promise<void> {
	return new Promise((r) => srv.close(() => r()));
}

afterEach(async () => {
	await Promise.all(open.splice(0).map(close));
});

describe('probePort', () => {
	it('detects an IPv6-only (::1) listener', async () => {
		const port = await listen('::1');
		expect(await probePort(port)).toBe(true);
	});

	it('detects an IPv4-only (127.0.0.1) listener', async () => {
		const port = await listen('127.0.0.1');
		expect(await probePort(port)).toBe(true);
	});

	it('returns false when nothing is listening', async () => {
		// Bind to claim a port, then release it so the probe hits a closed port.
		const port = await listen('127.0.0.1');
		await close(open.pop()!);
		expect(await probePort(port, 200)).toBe(false);
	});
});
