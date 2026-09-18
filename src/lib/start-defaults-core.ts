import { AGENT_KINDS, type AgentKind, type DeckEffort, type DeckSettings, type Project } from './types';
import { resolveModelChoice } from './models';
import { resolveEffort } from './effort';

// What a new session starts with when the user picks nothing: the one set of
// rules behind the web new-session modal's preselection and the agent API's
// GET /api/agent/defaults, so a native client (phone, watch, Siri) reads the
// same defaults instead of re-deriving them. Node-free; the route feeds it the
// stored project and settings.

export interface KindStartDefaults {
	// The model to send ('' means let the CLI pick) and, for pi, its provider.
	model: string;
	provider?: string;
	// claude-only reasoning effort; absent runs the CLI default.
	effort?: DeckEffort;
	// claude runs with permission prompts bypassed unless asked otherwise (the
	// modal's YOLO toggle, on by default); other kinds take the CLI default.
	permissionMode?: 'bypassPermissions';
}

export interface ProjectStartDefaults {
	path: string;
	// The base branch a new worktree branches from (the project's last pick).
	base?: string;
	// The first prompt per mode: the project's template / review prompt, when
	// configured. Absent means the session starts idle unless the client sends one.
	prompts: { work?: string; review?: string };
	kinds: Record<AgentKind, KindStartDefaults>;
}

export const DEFAULT_CLAUDE_PERMISSION_MODE = 'bypassPermissions';

export function kindStartDefaults(
	kind: AgentKind,
	project: Project | undefined,
	settings: DeckSettings
): KindStartDefaults {
	const choice = resolveModelChoice(kind, project, settings);
	const defaults: KindStartDefaults = { model: choice.model };
	if (kind === 'pi' && choice.provider) defaults.provider = choice.provider;
	if (kind === 'claude') {
		const effort = resolveEffort(project, settings);
		if (effort) defaults.effort = effort;
		defaults.permissionMode = DEFAULT_CLAUDE_PERMISSION_MODE;
	}
	return defaults;
}

function nonEmpty(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

export function projectStartDefaults(project: Project, settings: DeckSettings): ProjectStartDefaults {
	const kinds = {} as Record<AgentKind, KindStartDefaults>;
	for (const kind of AGENT_KINDS) kinds[kind] = kindStartDefaults(kind, project, settings);
	const defaults: ProjectStartDefaults = {
		path: project.path,
		prompts: {},
		kinds
	};
	const base = nonEmpty(project.lastBase);
	if (base) defaults.base = base;
	const work = nonEmpty(project.template);
	const review = nonEmpty(project.reviewPrompt);
	if (work) defaults.prompts.work = work;
	if (review) defaults.prompts.review = review;
	return defaults;
}
