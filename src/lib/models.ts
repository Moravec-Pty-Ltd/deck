import type { AgentKind, DeckSettings, ModelChoice, Project, SessionKind } from '$lib/types';

// Claude model shortnames the CLI accepts, offered in the New Session modal and
// the mid-session model switcher (issue #88). pi/codex take free-text ids.
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

// Fallback model when neither the project nor the user's global settings
// remember a pick for this kind (issue #51). Claude gets a real default now the
// blank "default model" option is gone; the other kinds fall through to the
// CLI's own default (empty) unless the user set a local ~/.deck default.
const DEFAULT_CLAUDE_MODEL = 'opus';

// Which model the new-session modal pre-selects for a kind: the project's last
// pick, else the global last-used (fresh-project fallback), else the built-in
// default. Deliberately public-repo-safe — any private-infra default lives only
// in the user's local settings, never here.
export function resolveModelChoice(
	kind: AgentKind,
	project: Project | undefined,
	settings: DeckSettings
): ModelChoice {
	const remembered = project?.lastModels?.[kind] ?? settings.lastModels?.[kind];
	if (remembered) return remembered;
	return { model: kind === 'claude' ? DEFAULT_CLAUDE_MODEL : '' };
}

// Whether the new-session modal should re-seed the model/provider fields from
// the resolved default. A kind change always re-seeds (the prior text belongs to
// a different agent); a project change re-seeds only between two *defined*
// projects, so the initial `undefined -> project` hydration (the projects list
// still loading) never wipes a model typed before it lands. Keeps the model pick
// project-scoped like the modal's issue/PR/base picks.
export function shouldReseedModel(
	prev: { kind: SessionKind | null; projectPath: string | undefined },
	next: { kind: SessionKind; projectPath: string | undefined }
): boolean {
	if (prev.kind !== next.kind) return true;
	return (
		prev.projectPath !== undefined &&
		next.projectPath !== undefined &&
		prev.projectPath !== next.projectPath
	);
}

// Display name for a session's model wherever it surfaces (header chip, palette
// hint, transcript marker): an unset model means the CLI's default.
export function modelLabel(model: string | undefined): string {
	return model || 'default';
}

// Switch a session's model (shared by the header ModelMenu and the palette's
// model step). Empty string resets to the default. Throws with the server's
// message on failure so callers can show it inline.
export async function switchModel(id: string, model: string): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/model`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model })
	});
	if (!res.ok) {
		const data = await res.json().catch(() => null);
		throw new Error(data?.message || 'model switch failed');
	}
}
