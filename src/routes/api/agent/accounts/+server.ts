import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteAccount, listAccountViews, saveAccount } from '$lib/server/accounts';
import { objectBody } from '$lib/server/http';

// Claude accounts a project's sessions can run under (issue #362). Secrets go
// in, never out: the views carry whether an account is ready, not its key.
export const GET: RequestHandler = async () => json(await listAccountViews());

export const POST: RequestHandler = async ({ request }) => {
	const body = await objectBody(request);
	try {
		return json(await saveAccount(body), { status: 201 });
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid account');
	}
};

export const DELETE: RequestHandler = ({ url }) => {
	const name = url.searchParams.get('name');
	if (!name) error(400, 'name required');
	deleteAccount(name);
	return json({ ok: true });
};
