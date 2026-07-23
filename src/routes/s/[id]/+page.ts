import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { DeckSession } from '$lib/types';

export const ssr = false;

export const load: PageLoad = async ({ params, fetch }) => {
	const res = await fetch(`/api/sessions/${encodeURIComponent(params.id)}`);
	if (!res.ok) error(res.status, 'session not found');
	const session: DeckSession = await res.json();
	// The authenticated gh login, for PrMenu's own-PR merge gate. Best-effort: a
	// failed resolve leaves `me` null and the gate falls back to allowing merge.
	const me = await fetch('/api/user')
		.then((r) => (r.ok ? r.json() : null))
		.then((d: { login: string | null } | null) => d?.login ?? null)
		.catch(() => null);
	// The `zed ssh://…` command for this session's cwd, composed server-side (it
	// needs the deck user + request hostname). Fetched here so the "Open in Zed"
	// copy stays inside the click gesture. Null for a session with no cwd.
	const zedCommand = await fetch(`/api/sessions/${encodeURIComponent(params.id)}/zed`)
		.then((r) => (r.ok ? r.json() : null))
		.then((d: { command: string | null } | null) => d?.command ?? null)
		.catch(() => null);
	return { session, me, zedCommand };
};
