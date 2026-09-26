import { json, error } from '@sveltejs/kit';
import { getStoredSession, updateSession } from './store';
import { objectBody } from './http';
import { publishAgentEvent } from './agent-feed';
import { listTmuxSessions, renameTmuxSession } from './tmux';
import { invalidateSessionList } from './sessions';
import { SERVER_TMUX_PREFIX } from './devservers-core';
import { parseTitle } from '$lib/session-title';
import { adhocId, adhocTmuxName, isAdhocId, tmuxSessionName } from './session-title-core';

// Rename a session. Shared verbatim by /api/sessions/[id]/title (browser) and
// /api/agent/sessions/[id]/title (agent API) so the two surfaces stay
// identical, the way session-model.ts and session-effort.ts are. Allowed while
// a turn runs: a title is a label, not a setting the runtime reads.
//
// The reply always carries `id`, because renaming an adhoc terminal moves it:
// such a session has no deck record, so its title is the tmux session name and
// the id deck derives from it changes with it. Callers should follow that id.

async function renameAdhoc(id: string, title: string): Promise<Response> {
	const from = adhocTmuxName(id);
	const to = tmuxSessionName(title);
	const live = await listTmuxSessions();
	if (!live.some((t) => t.name === from)) error(404, 'session not found');
	if (to === from) return json({ ok: true, id, title: to });
	if (live.some((t) => t.name === to)) error(409, 'a terminal with that name already exists');
	// Dev-server panes are filtered out of the session list, so a terminal that
	// took one of their names would drop off the list still running, with no way
	// back: there would be no row left to rename.
	if (to.startsWith(SERVER_TMUX_PREFIX)) error(400, `a name cannot start with ${SERVER_TMUX_PREFIX}`);
	try {
		await renameTmuxSession(from, to);
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'tmux refused the new name');
	}
	// No store write happened, so the session list's memo still holds the old
	// name. Drop it here or the redirect to the new id can land on a list that
	// has never heard of it.
	invalidateSessionList();
	// Published against the old id: that is the handle a consumer is holding, and
	// the payload tells it where the session moved to.
	publishAgentEvent(id, 'session-renamed', { title: to, id: adhocId(to) });
	return json({ ok: true, id: adhocId(to), title: to });
}

export async function renameSession(event: {
	params: Partial<Record<string, string>>;
	request: Request;
}): Promise<Response> {
	const id = event.params.id!;
	const body = await objectBody(event.request);
	const parsed = parseTitle(body.title);
	if (!parsed.ok) error(400, parsed.reason);

	const stored = getStoredSession(id);
	if (!stored) {
		if (!isAdhocId(id)) error(404, 'session not found');
		return renameAdhoc(id, parsed.title);
	}
	// Unchanged is a no-op so re-saving the same title doesn't spam the event log.
	if (stored.title !== parsed.title) {
		updateSession(id, { title: parsed.title });
		publishAgentEvent(id, 'session-renamed', { title: parsed.title, id });
	}
	return json({ ok: true, id, title: parsed.title });
}
