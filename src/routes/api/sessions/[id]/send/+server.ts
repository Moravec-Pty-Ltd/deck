import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentKind } from '$lib/types';
import { getSession } from '$lib/server/sessions';
import { agentInterrupt } from '$lib/server/agents/dispatch';
import { sendKeys, sendRawKey } from '$lib/server/tmux';
import { updateSession } from '$lib/server/store';
import { sendAgentMessage } from '$lib/server/send-agent-message';
import { objectBody } from '$lib/server/http';

// Best-effort recency bump: lastActiveAt is non-critical, so a failed store
// write must never block the actual send (or keystroke) it sits next to.
function anchorRecency(id: string) {
	try {
		updateSession(id, { lastActiveAt: Date.now() });
	} catch (err) {
		console.error(`[deck] failed to persist lastActiveAt for ${id}:`, err);
	}
}

export const POST: RequestHandler = async ({ params, request }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');

	const body = await objectBody(request);

	if (body.action === 'interrupt' || body.action === 'stop') {
		if (isAgentKind(session.kind)) agentInterrupt(session.id);
		return json({ ok: true });
	}

	if (isAgentKind(session.kind)) {
		await sendAgentMessage(session, body);
		return json({ ok: true, status: 'running' });
	}

	const text = String(body.text ?? '');
	if (!session.tmuxName) error(400, 'session has no tmux target');
	if (typeof body.key === 'string' && /^[A-Za-z0-9-]+$/.test(body.key)) {
		await sendRawKey(session.tmuxName, body.key);
	} else {
		await sendKeys(session.tmuxName, text, body.submit !== false);
	}
	if (session.managed) anchorRecency(session.id);
	return json({ ok: true });
};
