import { defineConfig } from 'vitest/config';

// Standalone config: unit tests cover pure modules, so we skip the SvelteKit
// plugin and its dev-server side effects (tailscale serve, port binding).
export default defineConfig({
	test: { include: ['src/**/*.test.ts'] }
});
