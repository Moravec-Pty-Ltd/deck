import { redirect } from '@sveltejs/kit';
import { PUBLIC_PATHS, noAuth, requestIsAuthed } from '$lib/server/config';
import type { LayoutServerLoad } from './$types';

// Auth guard at the load layer so it runs on client-side (SPA) navigations too,
// not just full document requests. SvelteKit re-runs this server load via
// __data.json whenever the router transitions between routes, so a protected page
// can't render its shell from a client nav without passing the same gate the
// request hook applies. Without a server load here that transition makes no server
// request at all, and the protected UI renders unauthenticated (issue #164). It
// must be a *server* load: the session cookie is httpOnly, so only the server can
// read it. Token logic is shared with hooks.server.ts via requestIsAuthed.
export const load: LayoutServerLoad = ({ url, request, cookies }) => {
	if (noAuth) return;
	if (PUBLIC_PATHS.has(url.pathname)) return;
	if (requestIsAuthed(request.headers, cookies)) return;
	redirect(302, '/login');
};
