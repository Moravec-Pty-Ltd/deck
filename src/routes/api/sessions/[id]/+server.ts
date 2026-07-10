import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, deleteSession } from '$lib/server/sessions';
import { refreshPrOnOpen } from '$lib/server/pr';

export const GET: RequestHandler = async ({ params }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	// This route is hit once per session open (the /s/[id] page load), so kick a
	// non-blocking live PR refresh here: the fresh status surfaces via the client's
	// 5s /api/sessions poll without making the open wait on gh.
	refreshPrOnOpen(params.id);
	return json(session);
};

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	let opts: { deleteWorktree?: boolean; deleteBranch?: boolean } = {};
	try {
		opts = await request.json();
	} catch {
		opts = {
			deleteWorktree: url.searchParams.get('worktree') === '1',
			deleteBranch: url.searchParams.get('branch') === '1'
		};
	}
	await deleteSession(params.id, opts);
	return json({ ok: true });
};
