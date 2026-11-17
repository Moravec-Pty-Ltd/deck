// Production entry: adapter-node's server plus WebSocket upgrades, which
// SvelteKit cannot handle. Importing the build starts it listening; its hooks
// (and so src/lib/server/tunnel.ts) have loaded by the time this runs.
// fallow-ignore-next-line unresolved-import
import { server } from './build/index.js';

server.server.on('upgrade', (req, socket, head) => {
	if (!globalThis.__deckTunnel?.(req, socket, head)) socket.destroy();
});
