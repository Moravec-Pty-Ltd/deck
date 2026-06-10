import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Allow the Tailscale tailnet hostnames (leading dot = host + subdomains) so
// `npm run dev` / `npm run preview` work behind `tailscale serve`. The
// production server (adapter-node, `node build/index.js`) has no such check.
const allowedHosts = ['.ts.net'];

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: { allowedHosts },
	preview: { allowedHosts }
});
