import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resetOperator } from '$lib/server/operator';

export const POST: RequestHandler = () => {
	resetOperator();
	return json({ ok: true });
};
