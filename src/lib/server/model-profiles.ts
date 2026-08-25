import type { ModelProfile } from '$lib/types';
import { readSettings } from './store';

// Resolve a session's model value to a locally-configured profile, if it names
// one. Profiles are keyed by their own id so they travel through the same paths
// as a normal model string (see ModelProfile in types.ts).
export function findModelProfile(model: string | undefined): ModelProfile | undefined {
	if (!model) return undefined;
	return (readSettings().modelProfiles ?? []).find((p) => p.id === model);
}

// The value to pass to the CLI's --model for this session: a profile's own
// `model`, else the raw session model. A profile with no `model` returns
// undefined so no flag is sent and the backend serves whatever it has loaded.
export function resolveModelArg(model: string | undefined): string | undefined {
	const profile = findModelProfile(model);
	return profile ? profile.model : model;
}
