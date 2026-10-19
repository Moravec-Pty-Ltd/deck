import type { AgentKind, ModelChoice } from '$lib/types';
import { isListableKind } from '$lib/models';

// Shared read-through cache of GET /api/agent/kinds: which agent CLIs are
// installed and the models each reports. The Projects page can show a work and
// a review lane on every expanded project at once, and each field fetching for
// itself would be one CLI shell-out per field; the New Session modal reads the
// same cache.

type KindRow = { kind: AgentKind; available: boolean; models: ModelChoice[] };

let rows = $state<KindRow[] | null>(null);
let inflight: Promise<void> | null = null;

// What's known for `kind`: empty until the listing lands, and empty for good if
// the CLI is missing or unconfigured, which leaves the field plain free text.
// Only the listable kinds count (claude's rows are its model profiles, which
// its pickers already offer from settings).
export function agentModels(kind: AgentKind): ModelChoice[] {
	if (!isListableKind(kind)) return [];
	return rows?.find((r) => r.kind === kind)?.models ?? [];
}

// Which kinds are installed, or null until the listing lands (or if it failed),
// which callers read as "show every kind".
export function agentAvailability(): Partial<Record<AgentKind, boolean>> | null {
	if (!rows) return null;
	return Object.fromEntries(rows.map((r) => [r.kind, r.available]));
}

export function loadAgentKinds(): Promise<void> {
	if (rows) return Promise.resolve();
	inflight ??= fetch('/api/agent/kinds')
		.then((r) => {
			if (!r.ok) throw new Error(`kinds ${r.status}`);
			return r.json();
		})
		.then((list: KindRow[]) => {
			rows = Array.isArray(list) ? list : [];
		})
		// A missing CLI answers 200 with available:false, so a failure here is the
		// request itself: leave the cache unset so the next caller retries.
		.catch(() => {})
		.finally(() => (inflight = null));
	return inflight;
}

export function loadAgentModels(kind: AgentKind) {
	if (isListableKind(kind)) void loadAgentKinds();
}
