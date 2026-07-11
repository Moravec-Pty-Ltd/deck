import type { CostSummary } from '$lib/session-cost-core';
import type { DeckSession, SessionIssue, SessionKind, SessionPR, SessionStatus, WorkflowRun } from '$lib/types';
import { isAgentKind } from '$lib/types';
import { baseUrl } from './config';
import { transcriptCostSummary } from './transcript';

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
	worktree?: DeckSession['worktree'];
	issues?: SessionIssue[];
	pr?: SessionPR;
	workflowRun?: WorkflowRun;
	cost?: CostSummary;
}

export function sessionDigest(s: DeckSession): AgentSessionDigest {
	return {
		id: s.id,
		url: `${baseUrl}/s/${s.id}`,
		kind: s.kind,
		title: s.title,
		cwd: s.cwd,
		status: s.status,
		awaitingInput: !!s.awaitingInput,
		createdAt: s.createdAt,
		lastActiveAt: s.lastActiveAt,
		model: s.model,
		worktree: s.worktree,
		issues: s.issues ?? (s.issue ? [s.issue] : undefined),
		pr: s.pr,
		workflowRun: s.workflowRun,
		// Cheap: transcriptCostSummary is LRU-cached and extended incrementally.
		cost: isAgentKind(s.kind) ? transcriptCostSummary(s.id) : undefined
	};
}
