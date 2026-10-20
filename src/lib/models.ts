import type {
	AgentKind,
	AgentSettingsView,
	DeckSettings,
	ModelChoice,
	Project,
	RememberedPicks,
	SessionKind
} from '$lib/types';
import { agentPost, sessionPath } from '$lib/agent-api';

// Claude model shortnames the CLI accepts, offered in the New Session modal and
// the mid-session model switcher (issue #88). pi/codex take free-text ids.
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

// Model options for a claude picker: the built-in shortnames plus any locally
// configured profiles (a profile's id is its model value, so the rest of the
// model plumbing treats it like any other string). Profiles come from the user's
// ~/.deck settings, so this repo stays free of private-infra ids.
export function claudeModelOptions(
	settings: DeckSettings | AgentSettingsView | undefined
): { value: string; label: string }[] {
	const builtin = CLAUDE_MODELS.map((m) => ({ value: m, label: m }));
	const profiles = (settings?.modelProfiles ?? []).map((p) => ({
		value: p.id,
		label: p.label || p.id
	}));
	return [...builtin, ...profiles];
}

// The kinds whose CLI can enumerate models. Shared by the listing endpoint and
// the client-side cache so a third one can't gain a lister while its picker
// stays empty.
const LISTABLE_KINDS = ['pi', 'opencode', 'codex'] as const satisfies readonly AgentKind[];

export function isListableKind(kind: string): kind is (typeof LISTABLE_KINDS)[number] {
	return (LISTABLE_KINDS as readonly string[]).includes(kind);
}

// The provider and model suggestion lists for a pi picker, from whatever the CLI
// reported. Detection can leave a model without a provider, and pi's list spans
// every provider, so narrow the models to the chosen one when there is one.
export function piProviderOptions(detected: ModelChoice[]): string[] {
	return [...new Set(detected.map((m) => m.provider).filter((p): p is string => !!p))];
}

export function piModelOptions(detected: ModelChoice[], provider: string): string[] {
	return (provider ? detected.filter((m) => m.provider === provider) : detected).map((m) => m.model);
}

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
	settings: RememberedPicks
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

// Premium models worth a confirm before you select one, so an accidental pick
// doesn't run costly work on a top-tier model (issue #134). Extend by editing
// the list.
export const EXPENSIVE_MODELS = ['fable', 'sol', 'astra'] as const;

// Whether choosing this model should prompt a cost confirm. Case-insensitive
// substring match against the model id (and provider, for pi's separate
// --provider arg), so one entry covers the claude shortname (`fable`), a
// codex/pi free-text id, and opencode's combined `provider/model`. `list` is
// the server's expensiveModels (GET /api/agent/defaults) when a client has it.
export function isExpensiveModel(
	model: string | undefined,
	provider?: string,
	list: readonly string[] = EXPENSIVE_MODELS
): boolean {
	const haystack = `${model ?? ''} ${provider ?? ''}`.toLowerCase();
	return list.some((m) => haystack.includes(m.toLowerCase()));
}

// A model listing with `expensive: true` on the rows that warrant the confirm,
// so a client that can't import this module (the native apps, an orchestrator)
// gets the same answer from GET /api/agent/kinds.
export function markExpensive(models: ModelChoice[]): (ModelChoice & { expensive?: true })[] {
	return models.map((m) => (isExpensiveModel(m.model, m.provider) ? { ...m, expensive: true } : m));
}

// Switch a session's model (shared by the header ModelMenu and the palette's
// model step). Empty string resets to the default. Throws with the server's
// message on failure so callers can show it inline.
export async function switchModel(id: string, model: string): Promise<void> {
	await agentPost(sessionPath(id, 'model'), { model });
}
