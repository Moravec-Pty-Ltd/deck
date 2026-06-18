import { execFile, execFileSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const PORT = 4818;

// Expose the dev server over the tailnet for the lifetime of `vite dev`.
// Serve is applied only after Vite has bound the port (so the two never
// contend for it) and removed on shutdown. The pre-emptive `off` clears any
// binding a previous crash left behind, which would otherwise read as
// "port in use" on the next start. Silent no-op when tailscale isn't present.
// Opt out entirely (no tailscale, native Windows, etc.) with DECK_NO_TAILSCALE=1.
function tailscaleServe(port: number): Plugin | false {
	if (process.env.DECK_NO_TAILSCALE === '1' || process.env.DECK_NO_TAILSCALE === 'true') {
		return false;
	}
	const args = (...rest: string[]) => ['serve', ...rest];
	const off = () => {
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
			off();
			server.httpServer?.once('listening', () => {
				execFile('tailscale', args('--bg', `--https=${port}`, `http://localhost:${port}`), () => {});
			});
			for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) process.once(sig, off);
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), tailscaleServe(PORT)],
	server: { allowedHosts: ['.ts.net'], port: PORT }
});
