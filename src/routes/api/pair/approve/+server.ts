import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { decidePairing } from '$lib/server/pairing';

// Authed (not in PUBLIC_PATHS): an already-signed-in browser approves or denies a
// pending request by its id. `ok` is false when the request expired or was already
// decided (the client just refreshes the pending list).
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { id?: unknown; approve?: unknown };
	if (typeof body.id !== 'string' || typeof body.approve !== 'boolean') error(400, 'invalid body');
	return json({ ok: decidePairing(body.id, body.approve) });
};
