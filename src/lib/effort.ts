import type { DeckEffort, DeckSettings, Project } from '$lib/types';

// Reasoning-effort levels the claude CLI accepts (`--effort`), offered next to the
// model in the New Session modal and the mid-session switcher (issue #178). Ordered
// low → high. claude-only; the other kinds have no equivalent flag.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Which effort the new-session modal pre-selects for a claude session: the
// project's last pick, else the global last-used (fresh-project fallback), else
// unset (the CLI's own default). Mirrors resolveModelChoice, but scalar since
// effort is claude-only.
export function resolveEffort(project: Project | undefined, settings: DeckSettings): DeckEffort | undefined {
	return project?.lastEffort ?? settings.lastEffort;
}

// Display name for a session's effort wherever it surfaces (header chip, create
// summary, transcript marker): an unset effort means the CLI's default. Accepts a
// bare string (the modal's "" default option) like modelLabel.
export function effortLabel(effort: string | undefined): string {
	return effort || 'default';
}

// Switch a session's effort (shared by the header EffortMenu). Empty string resets
// to the default. Throws with the server's message on failure so callers can show
// it inline.
export async function switchEffort(id: string, effort: string): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/effort`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ effort })
	});
	if (!res.ok) {
		const data = await res.json().catch(() => null);
		throw new Error(data?.message || 'effort switch failed');
	}
}
