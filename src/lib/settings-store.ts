import type { AgentSettingsView } from '$lib/types';

// Shared read-through cache for ~/.deck settings. The model pickers (New Session
// modal, header ModelMenu, command palette) all need `modelProfiles`, and each
// fetching on open would be three round-trips for a file that changes rarely.
let cache: AgentSettingsView | undefined;
let inflight: Promise<AgentSettingsView> | undefined;

export async function loadSettings(): Promise<AgentSettingsView> {
	if (cache) return cache;
	if (!inflight) {
		inflight = fetch('/api/agent/settings')
			.then((r) => (r.ok ? r.json() : {}))
			.then((s: AgentSettingsView) => (cache = s ?? {}))
			.catch(() => ({}) as AgentSettingsView)
			.finally(() => (inflight = undefined));
	}
	return inflight;
}
