import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { DeckSession } from '$lib/types';
import type { EditorLink } from '$lib/editors-core';
import { agentGet, agentPath, sessionPath } from '$lib/agent-api';

export const ssr = false;

export const load: PageLoad = async ({ params, fetch }) => {
	const res = await fetch(`/api/sessions/${encodeURIComponent(params.id)}`);
	if (!res.ok) error(res.status, 'session not found');
	const session: DeckSession = await res.json();
	// The authenticated gh login, for PrMenu's own-PR merge gate. Best-effort: a
	// failed resolve leaves `me` null and the gate falls back to allowing merge.
	const me = await agentGet<{ login: string | null }>(agentPath('user'), fetch)
		.then((d) => d?.login ?? null)
		.catch(() => null);
	// The links that open this session's cwd in an editor, composed server-side (they
	// need the deck user + request hostname). Fetched here so copying a command stays
	// inside the click gesture. Empty for a session with no cwd.
	const editors = await agentGet<{ editors: EditorLink[] }>(sessionPath(params.id, 'editors'), fetch)
		.then((d) => d?.editors ?? [])
		.catch((): EditorLink[] => []);
	return { session, me, editors };
};
