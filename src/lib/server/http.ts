import { error } from '@sveltejs/kit';

// Parse a JSON request body, asserting it is a plain object. Replies 400 on a
// missing, malformed, null, primitive, or array body so handlers can read
// fields without guarding each access.
export async function objectBody(request: Request): Promise<Record<string, unknown>> {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body)) error(400, 'invalid request body');
	return body as Record<string, unknown>;
}
