import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { completeDirs } from '$lib/server/fsutil';

export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	return json(completeDirs(q));
};
