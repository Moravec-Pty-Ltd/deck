import type { AgentKind, AutomationAgent, DeckEffort } from '$lib/types';

// The Projects page's automation lane form (issue #223), mapped to and from the
// stored `AutomationAgent`. Node-free so the round-trip is unit-tested: the
// clear-a-configured-lane path is easy to break, since the server reads an
// *omitted* agent key as "carry what's stored" (a stale client) and only an
// explicit empty object as "clear it".

// One lane's fields as the form holds them: '' for an unset string, undefined for
// an unset effort, and an explicit kind (claude is the server's own fallback).
export interface AgentRow {
	kind: AgentKind;
	model: string;
	provider: string;
	effort: DeckEffort | undefined;
}

export function toRow(agent: AutomationAgent | undefined): AgentRow {
	return {
		kind: agent?.kind ?? 'claude',
		model: agent?.model ?? '',
		provider: agent?.provider ?? '',
		effort: agent?.effort
	};
}

// Back to stored form. An untouched lane (claude, nothing else picked) sends an
// empty object rather than nothing: the server collapses that to absent, whereas
// an omitted key would carry the previously-stored pick and make "set it back to
// the default" unreachable from the form.
export function fromRow(row: AgentRow): AutomationAgent {
	const model = row.model.trim();
	const provider = row.provider.trim();
	if (row.kind === 'claude' && !model && !provider && !row.effort) return {};
	return { kind: row.kind, model: model || undefined, provider: provider || undefined, effort: row.effort };
}

// Drop the fields that don't apply to a newly-picked kind, so a pi provider or a
// claude effort can't linger and be rejected on save.
export function forKind(row: AgentRow, kind: AgentKind): AgentRow {
	return {
		kind,
		model: '',
		provider: kind === 'pi' ? row.provider : '',
		effort: kind === 'claude' ? row.effort : undefined
	};
}
