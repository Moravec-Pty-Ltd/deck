import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runWatchNow } from '$lib/server/watcher';

// Fire a watch now rather than at its due time. One that already fired or was
// cancelled comes back unchanged.
export const POST: RequestHandler = async ({ params }) => {
	const watch = runWatchNow(params.id!);
	if (!watch) error(404, 'watch not found');
	return json(watch);
};
