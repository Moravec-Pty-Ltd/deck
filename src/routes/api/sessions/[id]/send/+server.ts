import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isAgentKind } from '$lib/types';
import { getSession } from '$lib/server/sessions';
import { agentInterrupt } from '$lib/server/agents/dispatch';
import { sendAgentMessage } from '$lib/server/send-agent-message';
import { objectBody } from '$lib/server/http';
import { driveTerminal } from '$lib/server/terminal';

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

	await driveTerminal(session, body);
	return json({ ok: true });
};
