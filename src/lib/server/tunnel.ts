import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import { Duplex, pipeline } from 'node:stream';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { headerToken, noAuth } from './config';
import { credentialValid } from './auth';
import { sessionConnection } from './remote';
import { getStoredSession } from './store';
import { TUNNEL_HOST, admitTunnel } from './tunnel-core';

// GET /api/tunnel?port=<n>[&session=<id>]: the native dev browser's transport
// (issue #420). One WebSocket per proxied connection, raw bytes both ways, to
// the deck machine's loopback, or to a remote session's host over its ssh
// ControlMaster. SvelteKit can't take an upgrade, so the vite plugin (dev) and
// server.js (production) hand them here through the global below.

const wss = new WebSocketServer({ noServer: true });

function refuse(socket: Duplex, status: number, reason: string) {
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Header token only, never the cookie: a page in a browser could otherwise open
// this with the user's cookie and reach every port on the machine.
function authed(req: IncomingMessage): boolean {
	if (noAuth) return true;
	const headers = new Headers();
	for (const name of ['authorization', 'x-deck-token']) {
		const value = req.headers[name];
		if (typeof value === 'string') headers.set(name, value);
	}
	return credentialValid(headerToken(headers));
}

function openTarget(port: number, sessionId: string | undefined): Duplex {
	const session = sessionId ? getStoredSession(sessionId) : undefined;
	if (!session?.remote) return net.connect({ host: TUNNEL_HOST, port, autoSelectFamily: true });
	const conn = sessionConnection(session);
	const child = spawn('ssh', ['-W', `${TUNNEL_HOST}:${port}`, ...conn.args], { env: conn.env, stdio: ['pipe', 'pipe', 'ignore'] });
	// Node accepts a { readable, writable } pair here; @types/node only lists web streams.
	const stream = Duplex.from({ readable: child.stdout, writable: child.stdin } as unknown as Duplex);
	stream.on('close', () => child.kill());
	child.on('error', (e) => stream.destroy(e));
	return stream;
}

// Returns false for any other path, so the caller can let it fall through.
function handleTunnelUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
	const url = new URL(req.url ?? '/', 'http://localhost');
	if (url.pathname !== '/api/tunnel') return false;
	const admitted = admitTunnel(authed(req), req.headers.origin, url.searchParams, (id) => !!getStoredSession(id));
	if ('status' in admitted) {
		refuse(socket, admitted.status, admitted.reason);
		return true;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		let target: Duplex;
		try {
			target = openTarget(admitted.port, admitted.session);
		} catch {
			ws.close(1011, 'cannot reach the host');
			return;
		}
		// Keeps a quiet connection (a hot-reload socket between edits) from
		// being dropped as idle by a proxy in between. The app answers pings.
		const keepalive = setInterval(() => ws.ping(), 30_000);
		ws.on('close', () => clearInterval(keepalive));
		const client = createWebSocketStream(ws);
		// Either side ending or failing tears down both.
		pipeline(client, target, client, () => {
			client.destroy();
			target.destroy();
		});
	});
	return true;
}

(globalThis as { __deckTunnel?: typeof handleTunnelUpgrade }).__deckTunnel = handleTunnelUpgrade;
