import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { serverLogs } from '$lib/server/devservers';

// Live log pane for a dev server's tmux session, reusing the terminal snapshot
// tag/unchanged round-trip (see ShellView).
export const GET: RequestHandler = async ({ params, url }) => {
	const res = await serverLogs(params.id, params.name, url.searchParams.get('h'));
	if (!res) error(404, 'server not found');
	return json(res);
};
