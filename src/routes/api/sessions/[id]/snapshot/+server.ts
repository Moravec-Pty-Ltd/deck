import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/sessions';
import { stableSnapshot } from '$lib/server/tmux';

// FNV-1a, cheap enough to run per poll. Lets the client skip transferring and
// re-parsing a snapshot it already holds (see the `h`/`unchanged` round-trip).
function tag(text: string, cleared: boolean): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${cleared ? 'c' : 'l'}${(h >>> 0).toString(36)}`;
}

export const GET: RequestHandler = async ({ params, url }) => {
	const session = await getSession(params.id);
	if (!session) error(404, 'session not found');
	if (session.kind !== 'shell' || !session.tmuxName) error(400, 'not a shell session');
	if (session.status === 'dead') return json({ text: '(session is dead)', dead: true });

	const lines = Number(url.searchParams.get('lines') ?? 500);
	const prev = url.searchParams.get('h');
	try {
		const { text, cleared } = await stableSnapshot(session.tmuxName, Math.min(lines, 5000));
		const h = tag(text, cleared);
		if (prev === h) return json({ unchanged: true, h });
		return json({ text, cleared, dead: false, h });
	} catch {
		return json({ text: '(session is dead)', dead: true });
	}
};
