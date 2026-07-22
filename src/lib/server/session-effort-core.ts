import { EFFORT_LEVELS } from '$lib/effort';
import type { DeckEffort } from '$lib/types';

// Pure parse of an effort value (issue #178), shared by the create pipeline and
// the browser + agent effort routes via session-effort.ts. Mirrors parseModel,
// but validates against the fixed enum rather than the flag-injection guard.

export type ParsedEffort = { ok: true; effort: DeckEffort | undefined } | { ok: false };

// Absent resets to the CLI default; anything else must be a known effort level.
// Empty (after trim) also resets; an unknown string is a 400, not a silent drop.
export function parseEffort(raw: unknown): ParsedEffort {
	if (raw === undefined) return { ok: true, effort: undefined };
	if (typeof raw !== 'string') return { ok: false };
	const effort = raw.trim();
	if (!effort) return { ok: true, effort: undefined };
	if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) return { ok: false };
	return { ok: true, effort: effort as DeckEffort };
}
