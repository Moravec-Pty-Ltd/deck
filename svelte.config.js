import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter(),
		csp: {
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				// Svelte style attributes and Shiki's inline token colours.
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:', 'blob:'],
				'media-src': ['self', 'data:', 'blob:'],
				// The Linux shell's bridge (apps/linux) talks to Tauri over these two.
				'connect-src': ['self', 'ipc:', 'http://ipc.localhost'],
				// vite dev waits for a restarted server in a blob: worker.
				'worker-src': ['self', 'blob:'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none']
			}
		}
	}
};

export default config;
