import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { registerActivity, unregisterActivity } from '$lib/server/apns';
import { objectBody } from '$lib/server/http';
import { syncCard } from '$lib/server/live-activity';

// A phone started a Live Activity for a session: keep its push token so deck
// can update the card (status, last reply, cost) while the app is suspended.
// The session may have gone quiet before the card's token arrived, so the
// card is checked against it at once. DELETE forgets the token when the activity is dismissed on the phone.
export const POST: RequestHandler = async ({ request }) => {
	let sessionId: string;
	try {
		sessionId = registerActivity(await request.json());
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid activity');
	}
	void syncCard(sessionId);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await objectBody(request);
	if (typeof body.token !== 'string' || !body.token) error(400, 'token required');
	unregisterActivity(body.token);
	return json({ ok: true });
};
