import type { CostSummary } from '$lib/session-cost-core';
import type {
	DeckSession,
	Issue,
	Project,
	PullRequest,
	SessionIssue,
	SessionKind,
	SessionPR,
	SessionStatus,
	Workflow,
	WorkflowRun,
	WorkflowStep
} from '$lib/types';
import { isAgentKind } from '$lib/types';
import { isLegacyWorkflowId, resolveWorkflows } from '$lib/workflows-core';
import { baseUrl } from './config';
import { sessionLastResult, transcriptCostSummary } from './transcript';

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
	// The session's most recent assistant reply, attached only when requested (the
	// single-session GET), since it reads the transcript. Omitted on the list/feed
	// digests, which stay cheap. null means "no text produced yet".
	lastResult?: string | null;
}

export function sessionDigest(s: DeckSession, opts?: { lastResult?: boolean }): AgentSessionDigest {
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
		cost: isAgentKind(s.kind) ? transcriptCostSummary(s.id) : undefined,
		lastResult: opts?.lastResult && isAgentKind(s.kind) ? sessionLastResult(s.id) : undefined
	};
}

// ---- Discovery projections (issue #144) ----
// Stable agent-namespace views of the internal Project / Workflow / Issue /
// PullRequest rows, so the contract doesn't couple to their full stored shapes
// (dev config, sources, sync internals). Each maps directly onto a field the
// create / review calls accept.

export interface AgentProject {
	path: string;
	name: string;
	group?: string;
}

// The { path, name, group } an orchestrator needs to pick a valid `cwd`.
export function projectDigest(p: Project): AgentProject {
	return { path: p.path, name: p.name, group: p.group };
}

export interface AgentWorkflowStep {
	name: string;
	type: WorkflowStep['type'];
}

export interface AgentWorkflow {
	id: string;
	name: string;
	context: Workflow['context'];
	steps: AgentWorkflowStep[];
}

export function workflowDigest(w: Workflow): AgentWorkflow {
	return {
		id: w.id,
		name: w.name,
		context: w.context,
		steps: w.steps.map((s) => ({ name: s.name, type: s.type }))
	};
}

// The startable workflows for a project: the configured ones, with the
// synthesized legacy New/Review pair excluded — those are the plain-session path,
// not a startable workflowId (see workflows-core.ts).
export function startableWorkflows(project: Project | undefined): AgentWorkflow[] {
	return resolveWorkflows(project)
		.filter((w) => !isLegacyWorkflowId(w.id))
		.map(workflowDigest);
}

// Maps onto create's `issue { source, id, url }`.
export interface AgentIssue {
	source: SessionIssue['source'];
	id: string;
	title: string;
	url: string;
}

export function issueDigest(i: Issue): AgentIssue {
	return { source: i.sourceType, id: i.id, title: i.title, url: i.url };
}

// Maps onto review's `pr { repo, number }`; the rest is context for picking one.
export interface AgentPr {
	repo: string;
	number: number;
	title: string;
	url: string;
	headRefName: string;
	baseRefName: string;
	isDraft: boolean;
	author: string;
}

export function prDigest(p: PullRequest): AgentPr {
	return {
		repo: p.repo,
		number: p.number,
		title: p.title,
		url: p.url,
		headRefName: p.headRefName,
		baseRefName: p.baseRefName,
		isDraft: p.isDraft,
		author: p.author
	};
}
