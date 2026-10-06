import { execFile, execFileSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';

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

// Expose the dev server over the tailnet for the lifetime of `vite dev`, and
// take it down again on shutdown. Silent no-op when tailscale isn't present;
// opt out entirely (no tailscale, native Windows) with DECK_NO_TAILSCALE=1.
//
// Everything here acts on the port this server actually bound, never on the
// default. It used to use the constant, so a second instance -- `vite dev
// --port 4819` to try something beside the real one, or a plain `vite dev` that
// found 4818 taken -- cleared and re-pointed 4818 on the way up and cleared it
// again on the way down. That takes the running server off the tailnet while
// leaving it perfectly healthy on localhost, which reads as the PWA showing
// "deck is offline" for no visible reason.
function tailscaleServe(): Plugin | false {
	if (process.env.DECK_NO_TAILSCALE === '1' || process.env.DECK_NO_TAILSCALE === 'true') {
		return false;
	}
	const args = (...rest: string[]) => ['serve', ...rest];
	const off = (port: number) => {
		try {
			execFileSync('tailscale', args(`--https=${port}`, 'off'), { stdio: 'ignore' });
		} catch {
			/* tailscale missing or nothing bound */
		}
	};
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
				off(bound);
				execFile('tailscale', args('--bg', `--https=${bound}`, `http://localhost:${bound}`), () => {});
				for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) process.once(sig, () => off(bound));
			});
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), tailscaleServe()],
	server: { allowedHosts: ['.ts.net'], port: PORT }
});
