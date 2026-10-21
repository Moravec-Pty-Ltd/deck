import { execFile, execFileSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import { serveFailure, type ServeError } from './src/lib/server/tailscale-serve-core';

const PORT = 4818;

// Load .env file into process.env, respecting that explicit environment
// variables (already in process.env) take precedence over file values.
// With empty mode, loadEnv loads .env and .env.local (plus empty-mode variants).
const env = loadEnv('', process.cwd(), '');
for (const [key, value] of Object.entries(env)) {
	if (!(key in process.env) && value !== undefined) {
		process.env[key] = value;
	}
}

// The port vite is actually listening on. `server.port` is only a request: vite
// moves on to the next free one when it is taken, which is exactly the case
// this has to get right.
function boundPort(server: ViteDevServer): number {
	const addr = server.httpServer?.address();
	if (typeof addr === 'object' && addr) return addr.port;
	return server.config.server.port ?? PORT;
}

// Opt in with DECK_TAILSCALE=1: expose the dev server over the tailnet for the
// lifetime of `vite dev`, and take it down again on shutdown. Off by default
// because the node-level serve entry it writes outlives a reboot: tailscaled
// then holds 4818 before vite starts, vite moves to 4819, and the entry points
// at nothing. A Tailscale Service (see the README) has its own address and
// doesn't hold the port. Silent no-op when tailscale isn't present; any other
// failure warns once, since it leaves a mapping behind.
//
// Everything here acts on the port this server actually bound, never on the
// default. It used to use the constant, so a second instance -- `vite dev
// --port 4819` to try something beside the real one, or a plain `vite dev` that
// found 4818 taken -- cleared and re-pointed 4818 on the way up and cleared it
// again on the way down. That takes the running server off the tailnet while
// leaving it perfectly healthy on localhost, which reads as the PWA showing
// "deck is offline" for no visible reason.
function tailscaleServe(): Plugin | false {
	if (process.env.DECK_TAILSCALE !== '1' && process.env.DECK_TAILSCALE !== 'true') {
		return false;
	}
	const args = (...rest: string[]) => ['serve', ...rest];
	return {
		name: 'tailscale-serve',
		apply: 'serve',
		configureServer(server) {
			// Everything waits for the bind, so the port is known rather than
			// assumed. Clearing before binding would act on the *wanted* port,
			// which vite abandons when it is taken -- so starting a second server
			// with no --port would clear the first one's entry and then bind 4819.
			// A stale entry doesn't block the bind anyway: it holds the tailnet
			// addresses, not localhost, which is what vite listens on.
			server.httpServer?.once('listening', () => {
				const bound = boundPort(server);
				let warned = false;
				const report = (a: string[], err: ServeError, stderr = String(err.stderr ?? '')) => {
					const msg = serveFailure(a, err, stderr, bound);
					if (msg && !warned) {
						warned = true;
						server.config.logger.warn(msg);
					}
				};
				const off = () => {
					const a = args(`--https=${bound}`, 'off');
					try {
						execFileSync('tailscale', a, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000 });
					} catch (err) {
						report(a, err as ServeError);
					}
				};
				off();
				const bg = args('--bg', `--https=${bound}`, `http://localhost:${bound}`);
				execFile('tailscale', bg, (err, _out, stderr) => {
					if (err) report(bg, err, stderr);
				});
				for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) process.once(sig, off);
			});
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), tailscaleServe()],
	server: {
		allowedHosts: ['.ts.net'],
		port: PORT,
		// apps/ios builds gigabytes of Swift output in-tree; vite has no business watching it.
		watch: { ignored: ['**/apps/**'] }
	}
});
