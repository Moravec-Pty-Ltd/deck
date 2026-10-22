import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cancelWatch } from '$lib/server/watch-store';

// Cancel a watch. One that already fired or was cancelled comes back unchanged.
export const DELETE: RequestHandler = async ({ params }) => {
	const watch = cancelWatch(params.id!);
	if (!watch) error(404, 'watch not found');
	return json(watch);
};
