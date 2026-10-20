import type { CostSummary } from '$lib/session-cost-core';
import type { ContextUsage } from '$lib/context-core';
import type { DeckSession, SessionIssue, SessionKind, SessionPR, SessionStatus } from '$lib/types';

// The monitor-facing view of one session, served by /api/agent/sessions and as
// the /api/agent/events snapshot. A projection of DeckSession plus the cost
// total (which otherwise lives only inside the per-session SSE snapshot), with
// internal plumbing fields (tmux names, backfill markers, resume ids) dropped
// so the documented contract stays stable if those change.
export interface AgentSessionDigest {
	id: string;
	url: string;
	kind: SessionKind;
	title: string;
	cwd: string;
	status: SessionStatus;
	awaitingInput: boolean;
	createdAt: number;
	lastActiveAt: number;
	model?: string;
	// pi's --provider; absent for the kinds that carry it inside `model`.
	provider?: string;
	effort?: DeckSession['effort'];
	permissionMode?: DeckSession['permissionMode'];
	// Shells only: whether deck owns the tmux session (managed) and whether a
	// client is attached to it right now (attached).
	managed?: boolean;
	attached?: boolean;
	worktree?: DeckSession['worktree'];
	issues?: SessionIssue[];
	pr?: SessionPR;
	cost?: PublicCost;
	// How full the context window is. Omitted for a session that has not reported
	// a window yet (nothing to show a percentage against).
	context?: ContextUsage;
	// True when the session is in the "Hidden" section, either because it was
	// hidden itself or because its project was. Omitted when it isn't.
	hidden?: boolean;
	// The session's most recent assistant reply, attached only when requested (the
	// single-session GET), since it reads the transcript. Omitted on the list/feed
	// digests, which stay cheap. null means "no text produced yet".
	lastResult?: string | null;
}

// The documented shape of `cost`. CostSummary also carries `lastReportedCost`,
// the running total claude last reported, which exists only so a fold can
// resume; it is fold state, not a figure, so it stays off the contract.
export type PublicCost = Omit<CostSummary, 'lastReportedCost'>;

export function publicCost({ costUsd, turns, durationMs, results }: CostSummary): PublicCost {
	return { costUsd, turns, durationMs, results };
}

// What the web's session lists render: the same digest the agent API serves, so
// the browser and the native apps read one shape.
export type SessionView = AgentSessionDigest;
