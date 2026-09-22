import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resetOperator } from '$lib/server/operator';

// Start a new conversation; the old one is archived, not deleted.
export const POST: RequestHandler = () => {
	return json({ ok: true, archived: resetOperator() });
};
