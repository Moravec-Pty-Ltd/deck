import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { DeckSession } from '$lib/types';
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
	// The `zed ssh://…` command for this session's cwd, composed server-side (it
	// needs the deck user + request hostname). Fetched here so the "Open in Zed"
	// copy stays inside the click gesture. Null for a session with no cwd.
	const zedCommand = await agentGet<{ command: string | null }>(sessionPath(params.id, 'zed'), fetch)
		.then((d) => d?.command ?? null)
		.catch(() => null);
	return { session, me, zedCommand };
};
