import { describe, it, expect, afterEach, afterAll } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinEnv } from './test-env';

// Importing devservers pulls in config.ts, which derives its data dir and auth
// token from the env at import time (mkdir under ~/.deck, mint a token). Pin both
// to throwaway values before the module loads so this stays hermetic.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-devservers-'));
const restoreEnv = pinEnv({ DECK_DATA: tmpDir, DECK_TOKEN: 'test-token' });

const { probePort } = await import('./devservers');

afterAll(() => {
	restoreEnv();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

// Bind or return null on hosts with no such loopback family (e.g. IPv6 disabled
// in some CI/containers), so those tests skip rather than fail.
async function tryListen(host: string): Promise<number | null> {
	try {
		return await listen(host);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'ENOTSUP') return null;
		throw e;
	}
}

// Resilient to a server that never started listening (a failed tryListen still
// pushed it), which would otherwise throw ERR_SERVER_NOT_RUNNING on close.
function close(srv: net.Server): Promise<void> {
	return new Promise((r) => {
		try {
			srv.close(() => r());
		} catch {
			r();
		}
	});
}

afterEach(async () => {
	await Promise.all(open.splice(0).map(close));
});

describe('probePort', () => {
	it('detects an IPv6-only (::1) listener', async (ctx) => {
		const port = await tryListen('::1');
		if (port === null) return ctx.skip();
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

	it('resolves false for an out-of-range port instead of throwing or hanging', async () => {
		// net.connect throws synchronously here; probePort must still settle.
		expect(await probePort(999999)).toBe(false);
	});
});
