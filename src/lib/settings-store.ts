import type { DeckSettings } from '$lib/types';

// Shared read-through cache for ~/.deck settings. The model pickers (New Session
// modal, header ModelMenu, command palette) all need `modelProfiles`, and each
// fetching on open would be three round-trips for a file that changes rarely.
let cache: DeckSettings | undefined;
let inflight: Promise<DeckSettings> | undefined;

export async function loadSettings(): Promise<DeckSettings> {
	if (cache) return cache;
	if (!inflight) {
		inflight = fetch('/api/settings')
			.then((r) => (r.ok ? r.json() : {}))
			.then((s: DeckSettings) => (cache = s ?? {}))
			.catch(() => ({}) as DeckSettings)
			.finally(() => (inflight = undefined));
	}
	return inflight;
}
