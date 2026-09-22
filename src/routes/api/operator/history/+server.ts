import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { operatorHistory } from '$lib/server/operator';

// The recent conversation, for a client's log.
export const GET: RequestHandler = ({ url }) => {
	const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
	return json({ turns: operatorHistory(limit) });
};
