import type { AgentKind, ModelChoice } from '$lib/types';
import { isListableKind } from '$lib/models';

// Shared read-through cache for the models a CLI reports, alongside
// settings-store. The Projects page can show a work and a review lane on every
// expanded project at once, and each field fetching for itself would be one CLI
// shell-out per field; the New Session modal reads the same cache.
//
// Only the listable kinds enumerate anything (the endpoint answers every other
// kind with an empty list), so the rest never fetch.

let cache = $state<Partial<Record<AgentKind, ModelChoice[]>>>({});
const inflight = new Set<AgentKind>();

// What's known for `kind`: empty until the listing lands, and empty for good if
// the CLI is missing or unconfigured, which leaves the field plain free text.
export function agentModels(kind: AgentKind): ModelChoice[] {
	return cache[kind] ?? [];
}

export function loadAgentModels(kind: AgentKind) {
	if (!isListableKind(kind) || cache[kind] || inflight.has(kind)) return;
	inflight.add(kind);
	fetch(`/api/agents/${kind}/models`)
		.then((r) => {
			if (!r.ok) throw new Error(`models ${r.status}`);
			return r.json();
		})
		.then((list: ModelChoice[]) => {
			cache = { ...cache, [kind]: Array.isArray(list) ? list : [] };
		})
		// A CLI that isn't installed answers 200 with an empty list, so a failure
		// here is the request itself: leave the cache unset so the next lane to
		// mount retries, the way settings-store does.
		.catch(() => {})
		.finally(() => inflight.delete(kind));
}
