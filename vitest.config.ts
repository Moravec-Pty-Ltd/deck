import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Standalone config: unit tests cover pure modules and server data helpers, so we
// skip the SvelteKit plugin and its dev-server side effects (tailscale serve, port
// binding). $lib is aliased by hand since the plugin that normally provides it is
// absent.
export default defineConfig({
	resolve: { alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) } },
	test: { include: ['src/**/*.test.ts'] }
});
