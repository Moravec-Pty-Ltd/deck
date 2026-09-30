import { json, error } from '@sveltejs/kit';
import { objectBody } from './http';
import { setSessionHidden } from './hidden';
import { invalidateSessionList } from './sessions';

// Hide or unhide one session. Shared verbatim by /api/sessions/[id]/hidden
// (browser) and /api/agent/sessions/[id]/hidden (agent API), the way
// session-title.ts is, so the two surfaces can't drift.
//
// The id isn't checked against the session list: an adhoc terminal is only a
// live tmux session, so a check would be a race against tmux for no gain. A hide
// for an id that no longer exists is an unused line in hidden-sessions.json,
// cleared when the session is deleted.
export async function setHidden(event: {
	params: Partial<Record<string, string>>;
	request: Request;
}): Promise<Response> {
	const id = event.params.id!;
	const body = await objectBody(event.request);
	if (typeof body.hidden !== 'boolean') error(400, 'hidden must be a boolean');
	setSessionHidden(id, body.hidden);
	// Nothing was written to the store, so the list memo would keep serving the
	// old flag for its whole window.
	invalidateSessionList();
	return json({ ok: true, id, hidden: body.hidden });
}
