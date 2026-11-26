// Production entry: adapter-node's server plus WebSocket upgrades, which
// SvelteKit cannot handle. Importing the build starts it listening; its hooks
// (and so src/lib/server/tunnel.ts) have loaded by the time this runs.

// adapter-node would listen on every interface. Set before the import, which is
// what starts listening.
process.env.HOST ||= '127.0.0.1';

const { server } = await import('./build/index.js');

server.server.on('upgrade', (req, socket, head) => {
	if (!globalThis.__deckTunnel?.(req, socket, head)) socket.destroy();
});
