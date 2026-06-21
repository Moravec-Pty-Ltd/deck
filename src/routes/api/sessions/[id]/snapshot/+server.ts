import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/sessions';
import { stableSnapshot, snapshotTag } from '$lib/server/tmux';
import { DEMO, demoTerminalText } from '$lib/server/demo';

export const GET: RequestHandler = async ({ params, url }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	if (DEMO) return json({ text: demoTerminalText(params.id), cleared: false, dead: false });
	if (session.kind !== 'shell' || !session.tmuxName) error(400, 'not a shell session');
	if (session.status === 'dead') return json({ text: '(session is dead)', dead: true });

	const lines = Number(url.searchParams.get('lines') ?? 500);
	const prev = url.searchParams.get('h');
	try {
		const { text, cleared } = await stableSnapshot(session.tmuxName, Math.min(lines, 5000));
		const h = snapshotTag(text, cleared);
		if (prev === h) return json({ unchanged: true, h });
		return json({ text, cleared, dead: false, h });
	} catch {
		return json({ text: '(session is dead)', dead: true });
	}
};
